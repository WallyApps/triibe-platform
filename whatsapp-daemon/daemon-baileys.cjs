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
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const pino = require('pino');

const PORT = 4745;
const PLATFORM_DB = '/Users/rileywallack/triibe-platform/data/triibe.db';

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

// ---- State exposed via /status ---------------------------------------------
let READY = false;
let LAST_EVENT_AT = null;       // last 'messages.upsert' event timestamp
let LAST_BACKFILL_AT = null;    // last manual backfill completion
let LAST_BACKFILL_NEW = 0;      // # rows inserted during last backfill
let LAST_QR = null;             // QR data URL string (for /qr endpoint when needed)
let SOCK = null;                // active Baileys socket

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

  // PHASE 3 will wire 'messages.upsert' here. For now, just log + bump LAST_EVENT_AT
  // so /status reflects the daemon is actively receiving traffic.
  sock.ev.on('messages.upsert', (m) => {
    LAST_EVENT_AT = new Date().toISOString();
    if (process.env.DEBUG_WA) console.log('[wa-baileys] event:', m.type, m.messages?.length || 0);
    // TODO PHASE 3: ingest each message into DB (upsertThread + insertMsg)
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

  // QR endpoint — convenient browser-friendly QR display when terminal isn't visible
  if (req.method === 'GET' && url.pathname === '/qr') {
    if (!LAST_QR) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end(READY ? 'Already authenticated.\n' : 'No QR pending. Restart daemon to generate one.\n');
    }
    // Render QR as inline HTML (uses qrcode-terminal's data, encoded via a CDN)
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(LAST_QR)}`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!doctype html><meta charset=utf-8><title>WhatsApp QR</title>
<body style="background:#0a0a0a;color:#eee;font:14px system-ui;text-align:center;padding:30px">
<h1 style="font-weight:400">Scan this with WhatsApp on your phone</h1>
<p style="opacity:.6">Settings → Linked devices → Link a device</p>
<img src="${qrUrl}" style="background:#fff;padding:14px;border-radius:8px">
<p style="margin-top:20px;opacity:.5">This page won't auto-refresh. Reload after scanning.</p>
</body>`);
  }

  // /send — stub for Phase 1, implemented in Phase 2
  if (req.method === 'POST' && url.pathname === '/send') {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, reason: 'send not yet implemented in baileys daemon (phase 2)' }));
  }

  // /backfill — stub for Phase 1, implemented in Phase 2
  if (req.method === 'POST' && url.pathname === '/backfill') {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, reason: 'backfill not yet implemented in baileys daemon (phase 2)' }));
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
