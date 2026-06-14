// Triibe WhatsApp daemon (Baileys edition).
//
// REPLACES whatsapp-daemon/daemon.cjs which used whatsapp-web.js + Puppeteer +
// headless Chrome. That stack broke on Chrome 146 — the lib's injected script
// races the WhatsApp Web SPA's navigation (Execution context was destroyed at
// Client.inject). No working fix without forking the lib or pinning a long-
// deprecated Chrome version.
//
// Baileys talks the actual WhatsApp Web socket protocol natively (no browser,
// no Chrome, no Puppeteer). Resilient against WA Web UI changes — they don't
// affect us since we never load the page.
//
// HTTP server contract (same as old daemon for drop-in compat):
//   GET  /status                          → { ready, port, last_event_at, last_backfill_at }
//   POST /send   { chat_name, text }      → send a WhatsApp message
//   POST /backfill                        → force a manual catch-up scan
//
// PHASE 1 (this file as committed):
//   - Connect to WA via Baileys, print QR on first run, persist auth across restarts
//   - /status endpoint with ready flag + timestamps
//   - /send + /backfill stubs (return 501 until Phase 2)
//   - NO message ingest yet (Phase 3)
//
// SAFETY:
//   - Allowlist gated (reads ~/triibe-ops/whatsapp-bridge/allow.json if present)
//   - Default: SEND allowed to any chat (override with allow.json `send_chats`)
//   - No automation — server only sends when /send is hit by the platform server

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  downloadMediaMessage,
  getContentType,
  isJidGroup,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const qrImage = require('qrcode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const pino = require('pino');

const PORT = 4745;
const PLATFORM_DB = '/Users/rileywallack/triibe-platform/data/triibe.db';

// --- Crash hardening --------------------------------------------------------
// Baileys throws async Boom errors from inside the WebSocket message handler
// (group fetch timeouts, IQ query timeouts, etc) that aren't catchable at the
// call site — they bubble up as unhandledRejection and kill the process. The
// launchd watchdog will restart us, but each restart loses the WA WebSocket
// state and triggers another reconnect race. Swallow these here and let
// Baileys' own reconnect loop recover the socket.
process.on('unhandledRejection', (err) => {
  console.warn('[wa-baileys] unhandledRejection (suppressed):', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.warn('[wa-baileys] uncaughtException (suppressed):', err?.message || err);
});

// Auth state: kept SEPARATE from the old whatsapp-web.js .wwebjs_auth dir so
// the two daemons never conflict. First run Riley scans QR, subsequent boots
// resume the session from disk.
const AUTH_DIR = '/Users/rileywallack/triibe-platform/whatsapp-daemon/baileys-auth';
const BRIDGE_DIR = '/Users/rileywallack/triibe-ops/whatsapp-bridge';
const ALLOW_FILE = `${BRIDGE_DIR}/allow.json`;
const WA_MAP_FILE = '/Users/rileywallack/triibe-ops/data/wa_map.json';
const MEDIA_DIR = '/Users/rileywallack/triibe-platform/data/wa-media';

fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// Allowlist: read-only chats listed under `allow.chats` (or all if missing).
// Send permission: anything in `allow.send_chats` (defaults to all chats).
let ALLOW = { chats: [], send_chats: null };
if (fs.existsSync(ALLOW_FILE)) {
  try { ALLOW = JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8')); } catch {}
}

// Deal-mapping: chat name substring → deal_id, e.g. {"Nawa Sparkone": "accio-nawa"}
let WA_MAP = { brand_chats: {} };
if (fs.existsSync(WA_MAP_FILE)) {
  try { WA_MAP = JSON.parse(fs.readFileSync(WA_MAP_FILE, 'utf8')); } catch {}
}

const db = new DatabaseSync(PLATFORM_DB);
const sha = s => createHash('sha1').update(s).digest('hex').slice(0, 16);

// Prepared statements (same as old daemon — DB schema unchanged, drop-in compat)
const upsertThread = db.prepare(`
  INSERT INTO threads (id, deal_id, channel, subject, last_message_at, last_message_by, ball_in_court, updated_at)
  VALUES (?, ?, 'whatsapp', ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET deal_id=COALESCE(excluded.deal_id, threads.deal_id), subject=excluded.subject,
    last_message_at=excluded.last_message_at, last_message_by=excluded.last_message_by,
    ball_in_court=excluded.ball_in_court, updated_at=datetime('now')`);
const insertMsg = db.prepare(`
  INSERT INTO messages (id, thread_id, channel, sender, from_us, sent_at, snippet, body, raw_hash,
    media_type, media_path, media_mime, media_filename, media_size)
  VALUES (?, ?, 'whatsapp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET body=excluded.body, snippet=excluded.snippet,
    media_type=excluded.media_type, media_path=excluded.media_path,
    media_mime=excluded.media_mime, media_filename=excluded.media_filename,
    media_size=excluded.media_size`);

function matchDealByChatName(name) {
  const lc = (name || '').toLowerCase();
  for (const [substr, deal_id] of Object.entries(WA_MAP.brand_chats || {})) {
    if (lc.includes(substr.toLowerCase())) return deal_id;
  }
  return null;
}

// Extract the text body from a Baileys message envelope. WhatsApp has many
// message subtypes (conversation, extendedTextMessage, image+caption, etc.) —
// this normalizes them to a single string the platform can store.
function extractText(message) {
  if (!message) return '';
  return message.conversation
      || message.extendedTextMessage?.text
      || message.imageMessage?.caption
      || message.videoMessage?.caption
      || message.documentMessage?.caption
      || message.buttonsResponseMessage?.selectedDisplayText
      || message.listResponseMessage?.title
      || '';
}

// Map Baileys media subtype → our DB media_type vocabulary
function mediaTypeFor(messageType) {
  if (!messageType) return null;
  if (messageType === 'imageMessage') return 'image';
  if (messageType === 'videoMessage') return 'video';
  if (messageType === 'audioMessage') return 'audio';
  if (messageType === 'documentMessage') return 'document';
  if (messageType === 'stickerMessage') return 'sticker';
  return null;
}

function extFor(mime) {
  if (!mime) return 'bin';
  if (mime.startsWith('image/')) return mime.split('/')[1].split(';')[0];
  if (mime.startsWith('video/')) return mime.split('/')[1].split(';')[0];
  if (mime.startsWith('audio/')) return 'ogg';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('wordprocessingml')) return 'docx';
  if (mime.includes('msword')) return 'doc';
  if (mime.includes('spreadsheetml')) return 'xlsx';
  if (mime.includes('presentationml')) return 'pptx';
  if (mime.includes('zip')) return 'zip';
  return 'bin';
}

// Best-effort chat name resolver. Prefer learned name; fall back to JID.
// CRITICAL: for OUTBOUND messages (Riley sending to a brand), msg.pushName is
// Riley's own profile name, NOT the recipient. Using it as the chat name
// fallback creates junk threads like "wa:Riley". So we accept a `fromMe` flag
// and refuse to use pushName as a fallback when it's our own outbound.
function resolveChatName(jid, fallbackPushName, fromMe) {
  // Learned chat name always wins
  const learned = JID_TO_CHAT_NAME.get(jid);
  if (learned) return learned;
  // For incoming msgs, pushName is the sender (the contact we care about).
  // For outgoing msgs, pushName is OUR name — don't use it.
  if (!fromMe && fallbackPushName) return fallbackPushName;
  // Fall back to the JID's phone-number portion ("17785134803@s.whatsapp.net" → "17785134803")
  return (jid && jid.split('@')[0]) || 'unknown';
}

// Ingest a single Baileys message into the platform DB. Idempotent via
// raw_hash UNIQUE index on messages — re-ingesting the same message is a
// no-op. Mirrors the old daemon's behavior precisely so the rest of the
// platform (reconcile, this-week, chase queue, etc.) sees identical data
// regardless of which WA daemon is active.
async function ingestMessage(sock, msg) {
  try {
    const jid = msg.key?.remoteJid;
    if (!jid) return false;

    // Skip protocol noise (ephemeral key updates, etc.) — these have no message
    // content and would create junk rows
    if (!msg.message) return false;
    // Skip ephemeral messages we already handled (Baileys can re-emit on history sync)
    const messageType = getContentType(msg.message);
    if (!messageType) return false;
    // Skip status broadcasts
    if (jid === 'status@broadcast') return false;

    const fromMe = !!msg.key.fromMe;
    // Get the chat name (learn it if it's an individual contact we haven't seen)
    // CRITICAL: only learn pushName from INBOUND messages — outbound messages
    // carry Riley's own pushName, which would mislabel the chat as "Riley".
    if (msg.pushName && !fromMe && !isJidGroup(jid) && !JID_TO_CHAT_NAME.has(jid)) {
      rememberChat(jid, msg.pushName);
    }
    const chatName = resolveChatName(jid, msg.pushName, fromMe);

    // Allowlist filter (read-side): only ingest chats Riley wants tracked
    if (ALLOW.chats?.length && !ALLOW.chats.some(s => chatName.includes(s))) return false;

    // Sender label: "Riley" for outbound, contact name for inbound, group sender
    // name for group messages (Baileys puts that in msg.pushName for the participant)
    const senderName = fromMe ? 'Riley' : (msg.pushName || chatName);

    // Timestamp: Baileys gives Unix seconds in messageTimestamp (sometimes as a
    // BigInt — coerce to Number defensively)
    const tsSec = Number(msg.messageTimestamp || Date.now() / 1000);
    const ts = new Date(tsSec * 1000).toISOString();

    // Thread + message identifiers (keep parity with old daemon so DB queries
    // don't need updates)
    const threadId = 'wa:' + chatName;
    const body = extractText(msg.message);
    const snippet = body.slice(0, 140);
    // Use Baileys' own message ID for stable de-dup across daemon restarts.
    // Fall back to a content hash if for some reason the ID is missing.
    const msgId = msg.key.id
      ? `wa:${threadId}:${msg.key.id}`
      : `wa:${threadId}:${sha(`${ts}:${body}:${fromMe ? 1 : 0}`)}`;

    const dealId = matchDealByChatName(chatName);
    upsertThread.run(threadId, dealId, chatName, ts, fromMe ? 'us' : 'them', fromMe ? 'them' : 'us');

    // Media download for image/video/audio/document
    let mediaType = null, mediaPath = null, mediaMime = null, mediaFilename = null, mediaSize = null;
    const isMedia = ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage'].includes(messageType);
    if (isMedia) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        if (buffer && buffer.length) {
          mediaSize = buffer.length;
          const messageContent = msg.message[messageType];
          mediaMime = messageContent?.mimetype || 'application/octet-stream';
          mediaFilename = messageContent?.fileName || `${messageType}-${Date.now()}.${extFor(mediaMime)}`;
          mediaType = mediaTypeFor(messageType);
          const safeName = String(mediaFilename).replace(/[^A-Za-z0-9._-]/g, '_');
          const fileName = `${sha(msgId)}-${safeName}`;
          fs.writeFileSync(`${MEDIA_DIR}/${fileName}`, buffer);
          mediaPath = `wa-media/${fileName}`;
          if (!msg._backfillMode) {
            console.log(`[wa-baileys]   📎 ${mediaType}: ${mediaFilename} (${Math.round(mediaSize/1024)}KB)`);
          }
        }
      } catch (e) {
        if (!msg._backfillMode) console.warn(`[wa-baileys] media download failed for ${msgId}:`, e.message);
      }
    }

    const result = insertMsg.run(msgId, threadId, senderName, fromMe ? 1 : 0, ts, snippet, body, msgId,
                                  mediaType, mediaPath, mediaMime, mediaFilename, mediaSize);
    const wasNew = result.changes > 0;

    // Mirror media into the unified message_attachments table so the per-deal
    // Attachments strip on the UI picks it up
    if (mediaPath) {
      try {
        db.prepare(`INSERT OR IGNORE INTO message_attachments
          (message_id, thread_id, channel, media_path, media_filename, media_mime, media_size, media_type)
          VALUES (?, ?, 'whatsapp', ?, ?, ?, ?, ?)`).run(
          msgId, threadId, mediaPath, mediaFilename, mediaMime, mediaSize, mediaType);
      } catch { /* attachments table may not exist on very old DBs */ }
    }

    // Propagate to deal ball/activity (matches old daemon behavior)
    if (dealId && wasNew) {
      db.prepare(`UPDATE deals SET ball_in_court=?, last_activity_at=?, last_activity_by=? WHERE id=?`)
        .run(fromMe ? 'them' : 'us', ts, fromMe ? 'us' : 'them', dealId);
    }

    if (wasNew && !msg._backfillMode) {
      console.log(`[wa-baileys] ${fromMe ? '→' : '←'} ${chatName}: ${snippet.slice(0, 80)}`);
    }
    return wasNew;
  } catch (e) {
    console.warn('[wa-baileys] ingest error:', e.message);
    return false;
  }
}

// ---- State exposed via /status ---------------------------------------------
let READY = false;
let LAST_EVENT_AT = null;       // last 'messages.upsert' event timestamp
let LAST_BACKFILL_AT = null;    // last manual backfill completion
let LAST_BACKFILL_NEW = 0;      // # rows inserted during last backfill
let LAST_QR = null;             // QR data URL string (for /qr endpoint when needed)
let SOCK = null;                // active Baileys socket

// Chat-name → JID map. Populated as messages/chats stream in. Lowercase keys
// so substring lookups work case-insensitively. JIDs look like:
//   individual:  "15145551234@s.whatsapp.net"
//   group:       "120363025678-1234@g.us"
const CHAT_NAME_TO_JID = new Map();
const JID_TO_CHAT_NAME = new Map();

function rememberChat(jid, name) {
  if (!jid || !name) return;
  const lc = name.toLowerCase();
  CHAT_NAME_TO_JID.set(lc, jid);
  JID_TO_CHAT_NAME.set(jid, name);
}

function findJidByChatName(chatName) {
  if (!chatName) return null;
  const lc = chatName.toLowerCase();
  // Exact match first
  if (CHAT_NAME_TO_JID.has(lc)) return CHAT_NAME_TO_JID.get(lc);
  // Substring match (find first name that contains the query OR is contained by it)
  for (const [storedLc, jid] of CHAT_NAME_TO_JID.entries()) {
    if (storedLc.includes(lc) || lc.includes(storedLc)) return jid;
  }
  return null;
}

// ---- Connect to WhatsApp ---------------------------------------------------
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[wa-baileys] using WA web version ${version.join('.')} (latest: ${isLatest})`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,        // we handle QR display ourselves
    browser: Browsers.macOS('Triibe Desk'),
    logger: pino({ level: 'warn' }), // quiet by default; debug if needed
    syncFullHistory: false,          // we backfill via fetchMessages on demand
    markOnlineOnConnect: false,      // don't show "online" on Riley's phone
    generateHighQualityLinkPreview: false,
  });
  SOCK = sock;

  // Connection lifecycle
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      LAST_QR = qr;
      console.log('\n[wa-baileys] No saved session — scan this QR with WhatsApp on your phone:\n');
      qrcode.generate(qr, { small: true });
      console.log('\n(Or visit http://localhost:4745/qr to scan in browser)\n');
    }
    if (connection === 'open') {
      READY = true;
      LAST_QR = null;
      console.log('[wa-baileys] ✓ connected — listening for messages + HTTP on :' + PORT);
      // On open, populate the chat-name map from groups so /send can resolve
      // chats by name immediately (individual chats get learned as messages arrive)
      sock.groupFetchAllParticipating().then(groups => {
        for (const [jid, meta] of Object.entries(groups || {})) {
          if (meta?.subject) rememberChat(jid, meta.subject);
        }
        console.log(`[wa-baileys] learned ${Object.keys(groups || {}).length} group chats`);
      }).catch(e => console.warn('[wa-baileys] group fetch err:', e.message));
    } else if (connection === 'close') {
      READY = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[wa-baileys] connection closed (code ${code}); reconnect=${shouldReconnect}`);
      if (shouldReconnect) {
        // Reconnect after a brief delay
        setTimeout(() => connectToWhatsApp().catch(e => console.error('[wa-baileys] reconnect err:', e.message)), 3000);
      }
    }
  });

  // Persist auth state on every credential update (so restart resumes session)
  sock.ev.on('creds.update', saveCreds);

  // Live message ingest: every WA message lands in the platform DB the moment
  // it arrives over the socket. This is the core feature — once this is live,
  // the chase queue, last_outbound chip, and reconcile all see WA traffic in
  // real time (no more "you nudged Nawa today but the platform thinks you
  // didn't" gap).
  sock.ev.on('messages.upsert', async (m) => {
    LAST_EVENT_AT = new Date().toISOString();
    if (process.env.DEBUG_WA) console.log('[wa-baileys] event:', m.type, m.messages?.length || 0);
    // m.type: 'notify' (live), 'append' (history), 'prepend' (older history)
    // All three are worth ingesting — dedupe happens at the DB layer via raw_hash
    for (const msg of (m.messages || [])) {
      // History-sync messages are sometimes flagged via key.fromMe being weird
      // or messageTimestamp being old; we treat them like any other for ingest
      // since the UNIQUE index on raw_hash de-dupes naturally.
      await ingestMessage(sock, msg);
    }
  });

  // Also learn from chats.upsert / chats.set events so we don't have to wait
  // for a message to arrive before /send can resolve a chat name
  sock.ev.on('chats.upsert', (chats) => {
    for (const c of chats) {
      if (c.id && c.name) rememberChat(c.id, c.name);
    }
  });
  sock.ev.on('chats.set', ({ chats }) => {
    for (const c of (chats || [])) {
      if (c.id && c.name) rememberChat(c.id, c.name);
    }
  });

  return sock;
}

// ---- HTTP server ------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Status — drop-in compatible with old daemon's /status response shape
  if (req.method === 'GET' && url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ready: READY,
      port: PORT,
      backend: 'baileys',
      auth_dir: AUTH_DIR,
      last_event_at: LAST_EVENT_AT,
      last_backfill_at: LAST_BACKFILL_AT,
      last_backfill_new: LAST_BACKFILL_NEW,
      backfill_interval_ms: 3 * 60 * 1000,
      qr_pending: !!LAST_QR,
    }));
  }

  // QR endpoint — renders the current QR as inline SVG (no external image
  // service, no caching). Auto-refreshes every 8s so the page always shows the
  // freshest QR. WhatsApp rejects stale QRs with "Check your connection and try
  // again" so freshness matters.
  if (req.method === 'GET' && url.pathname === '/qr') {
    if (READY) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><meta charset=utf-8><body style="background:#0a0a0a;color:#7BC98A;font:18px system-ui;text-align:center;padding:60px"><h1>✓ Already connected</h1><p style="opacity:.6">You can close this tab.</p></body>');
    }
    if (!LAST_QR) {
      res.writeHead(503, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><meta charset=utf-8><meta http-equiv="refresh" content="2"><body style="background:#0a0a0a;color:#eee;font:14px system-ui;text-align:center;padding:60px"><h1>Waiting for QR…</h1><p style="opacity:.6">This page will refresh automatically.</p></body>');
    }
    try {
      const svg = await qrImage.toString(LAST_QR, {
        type: 'svg',
        errorCorrectionLevel: 'L',
        margin: 2,
        width: 400,
        color: { dark: '#000000', light: '#ffffff' },
      });
      const stamp = new Date().toISOString().slice(11, 19);
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      });
      return res.end(`<!doctype html><meta charset=utf-8><title>WhatsApp QR</title>
<!-- Auto-refresh every 8s so the displayed QR is always the freshest one.
     Baileys rotates the QR ~every 20s, so 8s keeps us well inside the window. -->
<meta http-equiv="refresh" content="8">
<body style="background:#0a0a0a;color:#eee;font:14px system-ui;text-align:center;padding:30px">
<h1 style="font-weight:400;margin:0 0 4px">Scan with WhatsApp</h1>
<p style="opacity:.55;margin:0 0 24px">Settings → Linked devices → Link a device</p>
<div style="display:inline-block;background:#fff;padding:18px;border-radius:14px">${svg}</div>
<p style="margin-top:18px;opacity:.45;font-size:11px;letter-spacing:.05em">QR rotated at ${stamp} · auto-refreshes every 8s</p>
</body>`);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('QR render error: ' + e.message);
    }
  }

  // /send — write a WhatsApp message. Same contract as the old daemon:
  //   POST { chat_name, text } → { ok, chat, jid, message_id } or { ok:false, reason }
  // chat_name is matched case-insensitively against learned chat names (exact
  // or substring). Allowlist check happens before send.
  if (req.method === 'POST' && url.pathname === '/send') {
    if (!READY || !SOCK) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, reason: 'daemon not ready' }));
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch { res.writeHead(400); return res.end(JSON.stringify({ ok: false, reason: 'bad json' })); }
      const { chat_name, text } = payload;
      if (!chat_name || !text) {
        res.writeHead(400);
        return res.end(JSON.stringify({ ok: false, reason: 'chat_name + text required' }));
      }
      try {
        const jid = findJidByChatName(chat_name);
        if (!jid) {
          res.writeHead(404);
          return res.end(JSON.stringify({
            ok: false,
            reason: `chat "${chat_name}" not found among ${CHAT_NAME_TO_JID.size} learned chats. Send a message TO this chat first so the daemon learns its JID, then retry.`,
          }));
        }
        // Allowlist check on the *learned* canonical name (matches old daemon behavior)
        const canonicalName = JID_TO_CHAT_NAME.get(jid) || chat_name;
        const allowSend = !ALLOW.send_chats || ALLOW.send_chats.some(s => canonicalName.includes(s));
        if (!allowSend) {
          res.writeHead(403);
          return res.end(JSON.stringify({ ok: false, reason: `chat "${canonicalName}" not on send allowlist` }));
        }
        const result = await SOCK.sendMessage(jid, { text });
        console.log(`[wa-baileys] ✓ sent to ${canonicalName}: ${text.slice(0, 80)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          chat: canonicalName,
          jid,
          message_id: result?.key?.id || null,
        }));
      } catch (e) {
        console.error('[wa-baileys] send error:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, reason: e.message }));
      }
    });
    return;
  }

  // /backfill — Baileys streams real-time messages natively over the WA socket
  // so the manual backfill loop that the old (Puppeteer) daemon needed is mostly
  // unnecessary. We still expose this endpoint for compat with the platform's
  // /api/sync flow. It re-fetches group metadata to refresh our chat-name map
  // and returns a count of any new chats learned.
  if (req.method === 'POST' && url.pathname === '/backfill') {
    if (!READY || !SOCK) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, reason: 'daemon not ready' }));
    }
    (async () => {
      const t0 = Date.now();
      let learnedNew = 0;
      try {
        const groups = await SOCK.groupFetchAllParticipating();
        for (const [jid, meta] of Object.entries(groups || {})) {
          if (!meta?.subject) continue;
          if (!JID_TO_CHAT_NAME.has(jid)) learnedNew++;
          rememberChat(jid, meta.subject);
        }
        LAST_BACKFILL_AT = new Date().toISOString();
        LAST_BACKFILL_NEW = learnedNew;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          backend: 'baileys',
          note: 'Baileys streams messages live over the WA socket — no manual message backfill needed. This endpoint refreshes the chat-name map.',
          chats_known: CHAT_NAME_TO_JID.size,
          new_chats_learned: learnedNew,
          duration_ms: Date.now() - t0,
          last_backfill_at: LAST_BACKFILL_AT,
        }));
      } catch (e) {
        console.error('[wa-baileys] backfill error:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, reason: e.message }));
      }
    })();
    return;
  }

  // /chats — debug endpoint, lists currently-learned chat names + JIDs.
  // Useful when /send returns 404 ("chat not found") to see what we know.
  if (req.method === 'GET' && url.pathname === '/chats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const list = [...JID_TO_CHAT_NAME.entries()].map(([jid, name]) => ({ jid, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return res.end(JSON.stringify({ count: list.length, chats: list }));
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`[wa-baileys] HTTP listening on http://localhost:${PORT}`));

// Boot
connectToWhatsApp().catch(e => {
  console.error('[wa-baileys] initial connect failed:', e);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[wa-baileys] shutting down…');
  if (SOCK) {
    try { SOCK.end(undefined); } catch {}
  }
  process.exit(0);
});
