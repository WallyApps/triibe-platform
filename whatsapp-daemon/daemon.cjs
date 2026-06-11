// Triibe WhatsApp daemon — long-running process that:
//   1. Reuses the bridge's saved LocalAuth session (no QR re-scan)
//   2. Listens for incoming messages and writes them DIRECTLY to the platform DB
//   3. Exposes an HTTP server on localhost:4745 with:
//        POST /send   { chat_name, text }    -> send a WhatsApp message
//        GET  /status                          -> ready / disconnected
//
// Run from a separate terminal: `npm run wa-daemon`
// Stop with Ctrl+C. Restarts pick up where you left off (uses persisted session).
//
// SAFETY:
//   - Allowlist gated (reads ~/triibe-ops/whatsapp-bridge/allow.json if present)
//   - Default: SEND is allowed to any chat (override with allow.json `send_chats` list)
//   - No automation: server only sends when a human-driven POST hits /send
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');

const PORT = 4745;
const PLATFORM_DB = '/Users/rileywallack/triibe-platform/data/triibe.db';
const BRIDGE_DIR = '/Users/rileywallack/triibe-ops/whatsapp-bridge';
const AUTH_DIR = `${BRIDGE_DIR}/.wwebjs_auth`;
const ALLOW_FILE = `${BRIDGE_DIR}/allow.json`;
const WA_MAP_FILE = '/Users/rileywallack/triibe-ops/data/wa_map.json';
const MEDIA_DIR = '/Users/rileywallack/triibe-platform/data/wa-media';
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// Allowlist: read-only chats listed under `allow.chats` (or all if missing).
// Send permission: anything in `allow.send_chats` (defaults to all chats in `chats`).
let ALLOW = { chats: [], send_chats: null };
if (fs.existsSync(ALLOW_FILE)) {
  try { ALLOW = JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8')); } catch {}
}

let WA_MAP = { brand_chats: {} };
if (fs.existsSync(WA_MAP_FILE)) {
  try { WA_MAP = JSON.parse(fs.readFileSync(WA_MAP_FILE, 'utf8')); } catch {}
}

const db = new DatabaseSync(PLATFORM_DB);
const sha = s => createHash('sha1').update(s).digest('hex').slice(0, 16);

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

// Determine file extension from mimetype
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

function matchDealByChatName(name) {
  const lc = (name || '').toLowerCase();
  for (const [substr, deal_id] of Object.entries(WA_MAP.brand_chats || {})) {
    if (lc.includes(substr.toLowerCase())) return deal_id;
  }
  return null;
}

// ---- Client setup ----------------------------------------------------------
// Use whatsapp-web.js's bundled Puppeteer (which ships with a known-good Chrome
// version). Avoids the Chrome 146 incompat we hit when Puppeteer auto-upgraded.
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
  puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] },
});

let READY = false;
let LAST_EVENT_AT = null;      // last message_create event timestamp (any direction)
let LAST_BACKFILL_AT = null;   // last periodic backfill completion
let LAST_BACKFILL_NEW = 0;     // # of messages inserted during last backfill run
client.on('qr', qr => {
  console.log('\n[wa-daemon] No saved session — scan this QR with WhatsApp on your phone:');
  qrcode.generate(qr, { small: true });
});
client.on('authenticated', () => console.log('[wa-daemon] ✓ authenticated'));
client.on('auth_failure', e => console.error('[wa-daemon] ✗ auth failure:', e));
client.on('ready', async () => {
  READY = true;
  console.log('[wa-daemon] ✓ ready — listening for messages + serving HTTP on :' + PORT);
  // Run an initial backfill 30s after ready so we catch anything that arrived
  // while the daemon was booting / restarting (the gap that bit us).
  setTimeout(() => { runBackfill().catch(()=>{}); }, 30_000);
});

// Shared ingest: writes a single WhatsApp message into the DB. Called from both
// the live message_create event AND the periodic backfill loop. Idempotent via
// raw_hash UNIQUE index — re-ingesting the same message is a no-op.
async function ingestMessage(msg, chat) {
  const chatName = chat.name || chat.id?._serialized || 'unknown';
  if (ALLOW.chats?.length && !ALLOW.chats.some(s => chatName.includes(s))) return false;
  const threadId = 'wa:' + chatName;
  const fromMe = !!msg.fromMe;
  const senderName = fromMe ? 'Riley' : (msg._data?.notifyName || chat.name || 'brand');
  const dealId = matchDealByChatName(chatName);
  const ts = new Date((msg.timestamp || Math.floor(Date.now()/1000)) * 1000).toISOString();
  const body = msg.body || '';
  const snippet = body.slice(0, 140);
  const msgId = `wa:${threadId}:${sha(`${ts}:${body}:${fromMe?1:0}`)}`;

  upsertThread.run(threadId, dealId, chatName, ts, fromMe ? 'us' : 'them', fromMe ? 'them' : 'us');

  // Download media if present (only on live event — backfill skips media to stay fast)
  let mediaType = null, mediaPath = null, mediaMime = null, mediaFilename = null, mediaSize = null;
  if (msg.hasMedia && !msg._backfillMode) {
    try {
      const media = await msg.downloadMedia();
      if (media?.data) {
        mediaMime = media.mimetype || 'application/octet-stream';
        mediaFilename = media.filename || `${msg.type}-${Date.now()}.${extFor(mediaMime)}`;
        const safeName = mediaFilename.replace(/[^A-Za-z0-9._-]/g,'_');
        const fileBuf = Buffer.from(media.data, 'base64');
        mediaSize = fileBuf.length;
        mediaType = msg.type || (mediaMime.startsWith('image/') ? 'image' :
                                  mediaMime.startsWith('video/') ? 'video' :
                                  mediaMime.startsWith('audio/') ? 'audio' : 'document');
        const filePath = `${MEDIA_DIR}/${sha(msgId)}-${safeName}`;
        fs.writeFileSync(filePath, fileBuf);
        mediaPath = `wa-media/${sha(msgId)}-${safeName}`;
        console.log(`[wa-daemon]   📎 ${mediaType}: ${mediaFilename} (${Math.round(mediaSize/1024)}KB)`);
      }
    } catch (e) {
      console.warn(`[wa-daemon] media download failed for ${msgId}:`, e.message);
    }
  }

  const result = insertMsg.run(msgId, threadId, senderName, fromMe ? 1 : 0, ts, snippet, body, msgId,
                mediaType, mediaPath, mediaMime, mediaFilename, mediaSize);
  const wasNew = result.changes > 0;
  if (mediaPath) {
    try {
      db.prepare(`INSERT OR IGNORE INTO message_attachments
        (message_id, thread_id, channel, media_path, media_filename, media_mime, media_size, media_type)
        VALUES (?, ?, 'whatsapp', ?, ?, ?, ?, ?)`).run(
        msgId, threadId, mediaPath, mediaFilename, mediaMime, mediaSize, mediaType);
    } catch (e) { /* table may not exist yet */ }
  }
  if (dealId && wasNew) {
    db.prepare(`UPDATE deals SET ball_in_court=?, last_activity_at=?, last_activity_by=? WHERE id=?`)
      .run(fromMe ? 'them' : 'us', ts, fromMe ? 'us' : 'them', dealId);
  }
  if (wasNew && !msg._backfillMode) {
    console.log(`[wa-daemon] ${fromMe?'→':'←'} ${chatName}: ${snippet.slice(0,80)}`);
  }
  return wasNew;
}

// Live message ingest — every new message lands in the platform DB instantly.
client.on('message_create', async msg => {
  try {
    LAST_EVENT_AT = new Date().toISOString();
    const chat = await msg.getChat();
    await ingestMessage(msg, chat);
  } catch (e) {
    console.warn('[wa-daemon] ingest error:', e.message);
  }
});

// Periodic backfill — catches anything message_create missed (daemon restart,
// brief crash, OS sleep, network blip). Idempotent — duplicates are dropped
// at the raw_hash UNIQUE index. Runs every 3 minutes.
async function runBackfill() {
  if (!READY) return;
  const t0 = Date.now();
  let scanned = 0, inserted = 0;
  try {
    const chats = await client.getChats();
    for (const chat of chats) {
      const chatName = chat.name || '';
      if (ALLOW.chats?.length && !ALLOW.chats.some(s => chatName.includes(s))) continue;
      try {
        const msgs = await chat.fetchMessages({ limit: 30 });
        for (const m of msgs) {
          m._backfillMode = true;  // skip media download + suppress per-line log
          try {
            const wasNew = await ingestMessage(m, chat);
            scanned++;
            if (wasNew) inserted++;
          } catch {}
        }
      } catch (e) {
        // Some chats (status broadcasts, etc.) can't be fetched — silently skip.
      }
    }
    LAST_BACKFILL_AT = new Date().toISOString();
    LAST_BACKFILL_NEW = inserted;
    if (inserted > 0) {
      console.log(`[wa-daemon] 🔄 backfill caught up ${inserted} missed messages (scanned ${scanned} across allowed chats in ${Date.now()-t0}ms)`);
    }
  } catch (e) {
    console.warn('[wa-daemon] backfill error:', e.message);
  }
}
setInterval(() => { runBackfill().catch(()=>{}); }, 3 * 60 * 1000);

client.on('disconnected', r => { READY = false; console.warn('[wa-daemon] disconnected:', r); });

console.log('[wa-daemon] initializing whatsapp-web.js (session: ' + AUTH_DIR + ')…');
client.initialize();

// ---- HTTP server ------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  // Status
  if (req.method === 'GET' && url.pathname === '/status') {
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({
      ready: READY,
      port: PORT,
      auth_dir: AUTH_DIR,
      last_event_at: LAST_EVENT_AT,
      last_backfill_at: LAST_BACKFILL_AT,
      last_backfill_new: LAST_BACKFILL_NEW,
      backfill_interval_ms: 3 * 60 * 1000,
    }));
  }
  // Manual backfill trigger — server hits this on /api/sync to force catch-up
  // without waiting for the 3min interval.
  if (req.method === 'POST' && url.pathname === '/backfill') {
    if (!READY) { res.writeHead(503); return res.end(JSON.stringify({ ok:false, reason:'not ready' })); }
    runBackfill().then(() => {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, last_backfill_at: LAST_BACKFILL_AT, inserted: LAST_BACKFILL_NEW }));
    }).catch(e => {
      res.writeHead(500); res.end(JSON.stringify({ ok:false, reason:e.message }));
    });
    return;
  }
  // Send
  if (req.method === 'POST' && url.pathname === '/send') {
    if (!READY) { res.writeHead(503); return res.end(JSON.stringify({ ok:false, reason:'daemon not ready' })); }
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body); } catch { return res.end(JSON.stringify({ ok:false, reason:'bad json' })); }
      const { chat_name, text } = payload;
      if (!chat_name || !text) { res.writeHead(400); return res.end(JSON.stringify({ ok:false, reason:'chat_name + text required' })); }
      try {
        const chats = await client.getChats();
        // Match the chat by substring (case-insensitive)
        const chat = chats.find(c => (c.name || '').toLowerCase().includes(chat_name.toLowerCase()));
        if (!chat) { res.writeHead(404); return res.end(JSON.stringify({ ok:false, reason:`chat "${chat_name}" not found among ${chats.length} chats` })); }
        const allowSend = !ALLOW.send_chats || ALLOW.send_chats.some(s => chat.name.includes(s));
        if (!allowSend) { res.writeHead(403); return res.end(JSON.stringify({ ok:false, reason:`chat "${chat.name}" not on send allowlist` })); }
        const result = await client.sendMessage(chat.id._serialized, text);
        console.log(`[wa-daemon] ✓ sent to ${chat.name}: ${text.slice(0,80)}`);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok:true, chat: chat.name, message_id: result.id?._serialized }));
      } catch (e) {
        console.error('[wa-daemon] send error:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ ok:false, reason:e.message }));
      }
    });
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(PORT, () => console.log(`[wa-daemon] HTTP listening on http://localhost:${PORT}`));

process.on('SIGINT', () => { console.log('\n[wa-daemon] shutting down…'); client.destroy().then(() => process.exit(0)); });
