// Gmail inbound provider — OAuth + polling for live Gmail data.
//
// Flow:
//   1. First run: open the browser to Google's consent page, capture the
//      code via a tiny local callback server, exchange for tokens, save them.
//   2. Subsequent runs: load tokens; googleapis auto-refreshes.
//   3. Polling: every 60s call `users.messages.list` with the query
//      `newer_than:1h (in:inbox OR in:sent)`, fetch message bodies, ingest
//      into the messages + threads tables.
//
// Why "in:sent" too? That's the whole point — when Riley taps Send on his
// iPhone, the API sees the sent message → we update ball_in_court='them' →
// the platform stops saying "needs reply" within ~60s.
//
// Scopes: gmail.readonly (we don't send through this provider; drafts go via
// the OpenAI draft provider + a separate send provider when wired).
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { google } from 'googleapis';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CRED_PATH  = join(ROOT, 'credentials', 'credentials.json');
const TOKEN_PATH = join(ROOT, 'credentials', 'token.json');
// gmail.modify covers read + create drafts + send + label.
// We use it because the platform sends approved drafts as threaded replies.
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

const OUR_DOMAINS = ['@triibetalents.com'];
const OUR_EMAILS  = ['cooper@theactionableai.com'];
const senderIsUs = sender => {
  const s = (sender || '').toLowerCase();
  return OUR_DOMAINS.some(d => s.includes(d)) || OUR_EMAILS.some(e => s.includes(e));
};
const sha = s => createHash('sha1').update(s).digest('hex').slice(0, 16);

// "Valentine Fourmentin <vfourmentin@hireinfluence.com>" -> "vfourmentin@hireinfluence.com"
function extractEmail(s) {
  if (!s) return null;
  const m = s.match(/<([^>]+)>/) || s.match(/([\w.+-]+@[\w.-]+)/);
  return m ? m[1].toLowerCase() : null;
}

// Senders we should NEVER thread a reply to (notifications, automation)
const AUTOMATED_SENDER_RE = /\(via google docs\)|\(via notion\)|drive-shares-noreply|@noreply\.|no-?reply@|mailer-daemon|notifications@|do-?not-?reply/i;
function isAutomatedSender(sender) { return AUTOMATED_SENDER_RE.test(sender || ''); }

// Match a thread to a deal by looking at any non-automated brand message sender's email.
function matchDealByEmailFromMessages(db, msgs, dealByEmail) {
  for (const m of msgs) {
    const sender = headerOf(m, 'From') || m.sender;
    if (senderIsUs(sender)) continue;
    if (isAutomatedSender(sender)) continue;
    const email = extractEmail(sender);
    if (email && dealByEmail[email]) return dealByEmail[email];
  }
  return null;
}

function loadCredentials() {
  if (!existsSync(CRED_PATH)) throw new Error('credentials.json missing — Gmail OAuth not set up yet');
  const { installed, web } = JSON.parse(readFileSync(CRED_PATH, 'utf8'));
  return installed || web;
}

export function makeOAuthClient() {
  const c = loadCredentials();
  // For desktop apps, Google supports redirect_uri="http://localhost" with
  // a port we pick at runtime — we just append the port we listen on.
  return new google.auth.OAuth2(c.client_id, c.client_secret, 'http://localhost');
}

export function hasToken() { return existsSync(TOKEN_PATH); }

export function loadAuthedClient() {
  const oAuth2 = makeOAuthClient();
  if (!hasToken()) return null;
  const tokens = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2.setCredentials(tokens);
  return oAuth2;
}

// ---- OAuth flow (one-time, interactive) ------------------------------------
// Launches a local HTTP server on a random port, points OAuth there, opens
// the browser, captures the `code` query param, exchanges for tokens, saves.
export async function runAuthFlow() {
  const oAuth2 = makeOAuthClient();

  // Start the local callback server FIRST so we know the port for redirect_uri.
  return new Promise((resolve, reject) => {
    let redirectUri;
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, redirectUri);
        const code = url.searchParams.get('code');
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('No code in callback');
          return;
        }
        oAuth2.redirectUri = redirectUri;
        const { tokens } = await oAuth2.getToken(code);
        writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="font-family:system-ui;background:#0a0a0a;color:#f2e8d5;text-align:center;padding:80px">
          <h1 style="font-family:Georgia,serif">✓ Triibe Platform connected to Gmail</h1>
          <p>You can close this tab and return to the Terminal.</p></body></html>`);
        server.close();
        resolve(tokens);
      } catch (e) {
        res.writeHead(500); res.end(String(e));
        server.close();
        reject(e);
      }
    });
    server.listen(0, () => {
      const port = server.address().port;
      redirectUri = `http://localhost:${port}`;
      oAuth2.redirectUri = redirectUri;
      const authUrl = oAuth2.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
        redirect_uri: redirectUri,
      });
      console.log('\n↗  Opening browser for Google consent…');
      console.log('   If it does not open, paste this URL into your browser:\n   ' + authUrl + '\n');
      spawn('open', [authUrl], { stdio: 'ignore', detached: true }).unref();
    });
  });
}

// ---- Polling / ingest -------------------------------------------------------
export class GmailInboundProvider {
  constructor(db) { this.db = db; this.gmail = null; }

  ready() {
    const client = loadAuthedClient();
    if (!client) return false;
    this.gmail = google.gmail({ version: 'v1', auth: client });
    return true;
  }

  // Pull recent activity. Default: last hour, both inbox and sent.
  async pull({ query = 'newer_than:1h (in:inbox OR in:sent)', maxResults = 50 } = {}) {
    if (!this.gmail && !this.ready()) {
      return { ok:false, reason:'Gmail OAuth not set up. Run `node tools/gmail-auth.js` first.' };
    }
    const list = await this.gmail.users.messages.list({
      userId: 'me', q: query, maxResults
    });
    const ids = (list.data.messages || []).map(m => m.id);
    if (!ids.length) return { ok:true, fetched:0, query };

    // Fetch FULL message bodies in parallel (bounded concurrency).
    const batch = await batchFetch(this.gmail, ids, 8);

    // Group by threadId
    const byThread = {};
    for (const msg of batch) {
      (byThread[msg.threadId] ||= []).push(msg);
    }

    // Build deal_id index from thread_id stored on deals
    const dealByThread = Object.fromEntries(
      this.db.prepare(`SELECT id, thread_id FROM deals WHERE thread_id IS NOT NULL`).all()
        .map(r => [r.thread_id, r.id])
    );

    const upsertThread = this.db.prepare(`
      INSERT INTO threads (id, deal_id, channel, subject, last_message_at, last_message_by, ball_in_court, updated_at)
      VALUES (?, ?, 'email', ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET deal_id=excluded.deal_id, subject=excluded.subject,
        last_message_at=excluded.last_message_at, last_message_by=excluded.last_message_by,
        ball_in_court=excluded.ball_in_court, updated_at=datetime('now')`);
    const insertMsg = this.db.prepare(`
      INSERT INTO messages (id, thread_id, channel, sender, from_us, sent_at, snippet, body, raw_hash)
      VALUES (?, ?, 'email', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET body=excluded.body, snippet=excluded.snippet`);
    const insertAtt = this.db.prepare(`
      INSERT OR IGNORE INTO message_attachments
        (message_id, thread_id, channel, media_path, media_filename, media_mime, media_size, media_type, source_attachment_id)
      VALUES (?, ?, 'email', ?, ?, ?, ?, ?, ?)`);

    let nThreads = 0, nMessages = 0, ballFlips = 0, nAtts = 0;
    for (const [tid, msgs] of Object.entries(byThread)) {
      msgs.sort((a,b) => Number(a.internalDate) - Number(b.internalDate));
      const last = msgs[msgs.length - 1];
      const sender = headerOf(last, 'From');
      const lastUs = senderIsUs(sender);
      const lastDate = new Date(Number(last.internalDate)).toISOString();
      const subject = headerOf(last, 'Subject') || '';
      const ballBefore = this.db.prepare('SELECT ball_in_court FROM threads WHERE id=?').get(tid);
      upsertThread.run(tid, dealByThread[tid] || null, subject, lastDate,
        lastUs ? 'us' : 'them', lastUs ? 'them' : 'us');
      if (ballBefore && ballBefore.ball_in_court !== (lastUs ? 'them' : 'us')) ballFlips++;
      nThreads++;

      for (const m of msgs) {
        const from = headerOf(m, 'From');
        const date = new Date(Number(m.internalDate)).toISOString();
        const body = extractBody(m);
        const snippet = (m.snippet || '').slice(0, 140);
        insertMsg.run(m.id, tid, from || null, senderIsUs(from) ? 1 : 0, date, snippet, body, m.id);
        nMessages++;
        // Download any attachments on this message (PDFs, decks, images, etc.)
        const atts = listAttachments(m);
        for (const att of atts) {
          // Skip inline tracking pixels + tiny images
          // Filter inline email signature / header images. These have a filename
          // in Gmail's MIME but are *not* user-attached. Heuristics:
          //  - small images (< 50KB) almost always = signature logos
          //  - any image named "noname" / "image001.png" / etc with no real extension
          const fname = (att.filename || '').toLowerCase();
          const isImg = att.mimeType?.startsWith('image/');
          if (isImg && (att.size || 0) < 50_000) continue;
          if (isImg && /^(noname|image\d+|untitled|inline|signature|logo)/.test(fname)) continue;
          const saved = await downloadAttachment({ gmail: this.gmail, messageId: m.id, attachment: att });
          if (saved) {
            insertAtt.run(m.id, tid, saved.media_path, saved.media_filename,
              saved.media_mime, saved.media_size, saved.media_type, att.attachmentId);
            nAtts++;
          }
        }
      }

      // Also push ball_in_court onto the deal itself for the UI
      if (dealByThread[tid]) {
        this.db.prepare(`UPDATE deals SET ball_in_court=?, last_activity_at=?,
          last_activity_by=? WHERE id=?`).run(
          lastUs ? 'them' : 'us', lastDate, lastUs ? 'us' : 'them', dealByThread[tid]
        );
        // Tier-2 auto-promote: if brand replied (not us) with lock-in language +
        // a matching $ amount AND the deal is in rate_sent/negotiating, flip it.
        if (!lastUs) {
          try {
            const { promoteFromEmailSignal } = await import('../engines/auto_promote.js');
            const freshDeal = this.db.prepare('SELECT * FROM deals WHERE id=?').get(dealByThread[tid]);
            const msgText = extractBody(last) || last.snippet || '';
            const r = promoteFromEmailSignal({ db: this.db, deal: freshDeal, msgText });
            if (r.promoted) console.log(`[auto-promote email] ${freshDeal.brand} → ${r.applied.new_raw_stage}`);
          } catch (e) { console.warn('[auto-promote email] failed:', e.message); }
        }
      }
      // E-sign envelope detection runs on EVERY thread (matched or not) since
      // DocuSign emails sometimes land in their own threads not linked to a deal.
      try {
        const { detectEsignEmail } = await import('../engines/auto_promote.js');
        const fromHeader = headerOf(last, 'From');
        const subjectHeader = headerOf(last, 'Subject');
        const bodyText = extractBody(last) || last.snippet || '';
        const r = detectEsignEmail({ db: this.db, fromHeader, subjectHeader, bodyText, threadDealId: dealByThread[tid] });
        if (r && !r.deduped) console.log(`[esign] ${r.kind}: ${subjectHeader?.slice(0,80)} → deal=${r.deal_id || 'unmatched'}${r.promoted ? ' (auto-signed)' : ''}`);
      } catch (e) { console.warn('[esign detect] failed:', e.message); }
      // Classify the LAST inbound message — gives the brain authority context.
      // Only when AI is on + we have a deal_id for context.
      if (!lastUs && dealByThread[tid] && process.env.OPENAI_API_KEY) {
        try {
          const { classifyMessage } = await import('../engines/classify_message.js');
          const dealRow = this.db.prepare('SELECT * FROM deals WHERE id=?').get(dealByThread[tid]);
          let obligations = [];
          try { obligations = JSON.parse(dealRow?.obligations || '[]'); } catch {}
          const cls = await classifyMessage({
            apiKey: process.env.OPENAI_API_KEY,
            message: { body: extractBody(last) || last.snippet, snippet: last.snippet },
            deal: dealRow, obligations,
          });
          if (cls) {
            this.db.prepare(`UPDATE messages SET classification=? WHERE id=?`)
              .run(JSON.stringify(cls), last.id);
          }
        } catch (e) { /* silent */ }
      }
    }
    return { ok:true, fetched: batch.length, threads: nThreads, messages: nMessages, ball_flips: ballFlips, attachments: nAtts };
  }
}

// ---- pull a single thread fresh (used before drafting a reply) -------------
// Faster than the full sweep: just refreshes ONE thread's messages so the
// draft modal always works on the latest brand reply, even if you hit "Draft"
// 10s after they sent it.
export async function pullSingleThread(db, threadId) {
  const oAuth2 = loadAuthedClient();
  if (!oAuth2 || !threadId) return { ok:false, reason:'no auth or thread id' };
  const gmail = google.gmail({ version:'v1', auth: oAuth2 });
  let thread;
  try {
    thread = (await gmail.users.threads.get({ userId:'me', id: threadId, format:'full' })).data;
  } catch (e) {
    return { ok:false, reason: e.message };
  }
  const msgs = (thread.messages || []).slice().sort((a,b) => Number(a.internalDate) - Number(b.internalDate));
  if (!msgs.length) return { ok:true, fetched:0 };

  const dealByThread = Object.fromEntries(
    db.prepare(`SELECT id, thread_id FROM deals WHERE thread_id IS NOT NULL`).all()
      .map(r => [r.thread_id, r.id])
  );
  // Also map deals by their contact email — rescues threads where deal.thread_id is
  // stale or wrong (e.g. pointing at a Google Doc notification thread).
  const dealByEmail = Object.fromEntries(
    db.prepare(`SELECT id, LOWER(contact_email) e FROM deals
                WHERE contact_email IS NOT NULL AND contact_email != ''`).all()
      .map(r => [r.e, r.id])
  );
  // Resolve deal_id: prefer explicit thread_id match, fall back to email match.
  let resolvedDealId = dealByThread[threadId] || matchDealByEmailFromMessages(db, msgs, dealByEmail);

  const upsertThread = db.prepare(`
    INSERT INTO threads (id, deal_id, channel, subject, last_message_at, last_message_by, ball_in_court, updated_at)
    VALUES (?, ?, 'email', ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET deal_id=COALESCE(excluded.deal_id, threads.deal_id), subject=excluded.subject,
      last_message_at=excluded.last_message_at, last_message_by=excluded.last_message_by,
      ball_in_court=excluded.ball_in_court, updated_at=datetime('now')`);
  const insertMsg = db.prepare(`
    INSERT INTO messages (id, thread_id, channel, sender, from_us, sent_at, snippet, body, raw_hash)
    VALUES (?, ?, 'email', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET body=excluded.body, snippet=excluded.snippet`);
  const insertAtt = db.prepare(`
    INSERT OR IGNORE INTO message_attachments
      (message_id, thread_id, channel, media_path, media_filename, media_mime, media_size, media_type, source_attachment_id)
    VALUES (?, ?, 'email', ?, ?, ?, ?, ?, ?)`);

  // Decode FULL messages — these come from threads.get already
  let nMsgs = 0, nAtts = 0;
  const last = msgs[msgs.length - 1];
  const lastSender = headerOf(last, 'From');
  const lastUs = senderIsUs(lastSender);
  const lastDate = new Date(Number(last.internalDate)).toISOString();
  const subject = headerOf(last, 'Subject') || '';
  upsertThread.run(threadId, resolvedDealId, subject, lastDate,
    lastUs ? 'us' : 'them', lastUs ? 'them' : 'us');

  for (const m of msgs) {
    const from = headerOf(m, 'From');
    const date = new Date(Number(m.internalDate)).toISOString();
    const body = extractBody(m);
    const snippet = (m.snippet || '').slice(0, 140);
    insertMsg.run(m.id, threadId, from || null, senderIsUs(from) ? 1 : 0, date, snippet, body, m.id);
    nMsgs++;
    const atts = listAttachments(m);
    for (const att of atts) {
      if ((att.size || 0) < 5_000 && att.mimeType?.startsWith('image/')) continue;
      const saved = await downloadAttachment({ gmail, messageId: m.id, attachment: att });
      if (saved) {
        insertAtt.run(m.id, threadId, saved.media_path, saved.media_filename,
          saved.media_mime, saved.media_size, saved.media_type, att.attachmentId);
        nAtts++;
      }
    }
  }
  // Also update deal's ball/activity (use the resolved deal id, not just thread match)
  if (resolvedDealId) {
    db.prepare(`UPDATE deals SET ball_in_court=?, last_activity_at=?, last_activity_by=? WHERE id=?`)
      .run(lastUs ? 'them' : 'us', lastDate, lastUs ? 'us' : 'them', resolvedDealId);
    // Tier-2 auto-promote on a brand-side lock-in reply
    if (!lastUs) {
      try {
        const { promoteFromEmailSignal } = await import('../engines/auto_promote.js');
        const freshDeal = db.prepare('SELECT * FROM deals WHERE id=?').get(resolvedDealId);
        const msgText = extractBody(last) || last.snippet || '';
        const r = promoteFromEmailSignal({ db, deal: freshDeal, msgText });
        if (r.promoted) console.log(`[auto-promote email] ${freshDeal.brand} → ${r.applied.new_raw_stage}`);
      } catch (e) { console.warn('[auto-promote email] failed:', e.message); }
    }
  }
  // E-sign envelope detection runs even when the thread isn't deal-linked
  try {
    const { detectEsignEmail } = await import('../engines/auto_promote.js');
    const fromHeader = headerOf(last, 'From');
    const subjectHeader = headerOf(last, 'Subject');
    const bodyText = extractBody(last) || last.snippet || '';
    const r = detectEsignEmail({ db, fromHeader, subjectHeader, bodyText, threadDealId: resolvedDealId });
    if (r && !r.deduped) console.log(`[esign] ${r.kind}: ${subjectHeader?.slice(0,80)} → deal=${r.deal_id || 'unmatched'}${r.promoted ? ' (auto-signed)' : ''}`);
  } catch (e) { console.warn('[esign detect] failed:', e.message); }
  return { ok:true, fetched:nMsgs, last_at:lastDate, last_by: lastUs ? 'us' : 'them', resolved_deal_id: resolvedDealId };
}

// ---- send: post a threaded reply via the Gmail API --------------------------
// Threads a reply correctly by referencing the original Message-ID. The reply
// is wrapped in an RFC 2822 MIME blob, base64-url encoded, sent via
// users.messages.send with the threadId.
export async function sendThreadedReply({ thread_id, reply_to_msg_id, to, subject, body }) {
  const oAuth2 = loadAuthedClient();
  if (!oAuth2) throw new Error('Gmail OAuth not set up — run `npm run gmail-auth` first.');
  const gmail = google.gmail({ version: 'v1', auth: oAuth2 });

  // Fetch the message we're replying to to get headers (Message-ID, References).
  let referencesHeader = '', inReplyToHeader = '', resolvedTo = to, resolvedSubject = subject;
  if (reply_to_msg_id) {
    try {
      const r = await gmail.users.messages.get({
        userId: 'me', id: reply_to_msg_id, format: 'metadata',
        metadataHeaders: ['Message-ID', 'References', 'From', 'Subject', 'Reply-To']
      });
      const hdrs = r.data.payload?.headers || [];
      const find = n => hdrs.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';
      const msgId = find('Message-ID');
      inReplyToHeader = msgId;
      referencesHeader = `${find('References') ? find('References') + ' ' : ''}${msgId}`.trim();
      // If caller didn't specify, fall back to brand's From or Reply-To
      if (!resolvedTo) resolvedTo = find('Reply-To') || find('From');
      if (!resolvedSubject) {
        const orig = find('Subject');
        resolvedSubject = orig.startsWith('Re:') ? orig : `Re: ${orig}`;
      }
    } catch (e) {
      console.warn('Could not fetch reply-to message for headers:', e.message);
    }
  }
  if (!resolvedTo) throw new Error('No recipient — could not resolve from thread.');
  if (!resolvedSubject) resolvedSubject = 'Re:';

  const lines = [
    `To: ${resolvedTo}`,
    `Subject: ${resolvedSubject}`,
    inReplyToHeader ? `In-Reply-To: ${inReplyToHeader}` : '',
    referencesHeader ? `References: ${referencesHeader}` : '',
    'Content-Type: text/plain; charset=UTF-8',
    'MIME-Version: 1.0',
    '',
    body,
  ].filter(Boolean).join('\r\n');

  const raw = Buffer.from(lines).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const sendRes = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId: thread_id || undefined },
  });
  return { id: sendRes.data.id, threadId: sendRes.data.threadId, to: resolvedTo, subject: resolvedSubject };
}

// ---- helpers ----------------------------------------------------------------
function headerOf(msg, name) {
  const h = (msg.payload?.headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}
function extractBody(msg) {
  // Walk the MIME tree, prefer text/plain, fall back to text/html stripped.
  const stack = [msg.payload];
  let html = null;
  while (stack.length) {
    const p = stack.shift();
    if (!p) continue;
    if (p.mimeType === 'text/plain' && p.body?.data) return decode(p.body.data);
    if (p.mimeType === 'text/html'  && p.body?.data) html = decode(p.body.data);
    if (p.parts) stack.push(...p.parts);
  }
  return html ? stripHtml(html) : (msg.snippet || '');
}
function decode(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

// Walk MIME tree for attachment parts (filename present, attachmentId present).
// Returns [{ filename, mimeType, attachmentId, size }].
export function listAttachments(msg) {
  const out = [];
  const stack = [msg.payload];
  while (stack.length) {
    const p = stack.shift();
    if (!p) continue;
    if (p.filename && p.body?.attachmentId) {
      out.push({
        filename: p.filename,
        mimeType: p.mimeType || 'application/octet-stream',
        attachmentId: p.body.attachmentId,
        size: p.body.size || null,
      });
    }
    if (p.parts) stack.push(...p.parts);
  }
  return out;
}

// Download attachment bytes via Gmail API + save to disk under data/email-media/.
// Returns { media_path (relative), media_filename, media_mime, media_size, media_type }
// or null on failure. Uses sha1 prefix to keep filenames unique + safe.
const EMAIL_MEDIA_DIR = '/Users/rileywallack/triibe-platform/data/email-media';
import { mkdirSync as _mkAttDir } from 'node:fs';
_mkAttDir(EMAIL_MEDIA_DIR, { recursive: true });

export async function downloadAttachment({ gmail, messageId, attachment }) {
  try {
    const r = await gmail.users.messages.attachments.get({
      userId: 'me', messageId, id: attachment.attachmentId,
    });
    const data = r.data?.data;
    if (!data) return null;
    const buf = Buffer.from(data.replace(/-/g,'+').replace(/_/g,'/'), 'base64');
    const safeName = (attachment.filename || 'file').replace(/[^A-Za-z0-9._-]/g,'_');
    const hash = createHash('sha1').update(messageId + ':' + attachment.attachmentId).digest('hex').slice(0,16);
    const fname = `${hash}-${safeName}`;
    const full = `${EMAIL_MEDIA_DIR}/${fname}`;
    if (!existsSync(full)) writeFileSync(full, buf);
    const mime = attachment.mimeType || 'application/octet-stream';
    const media_type = mime.startsWith('image/') ? 'image'
                      : mime.startsWith('video/') ? 'video'
                      : mime.startsWith('audio/') ? 'audio'
                      : 'document';
    return {
      media_path: `email-media/${fname}`,
      media_filename: attachment.filename || safeName,
      media_mime: mime,
      media_size: buf.length,
      media_type,
      full_path: full,
    };
  } catch (e) {
    console.warn('[gmail attachment] failed:', e.message);
    return null;
  }
}
// Strip the quoted reply chain from an email body so we only see the latest
// message. Strategy: the strongest universal quote signal is a line that
// starts with ">" — once we find that, walk backward over the attribution
// line (which can be in ANY language: "wrote:", "écrit", "schrieb", "写道",
// "escribió", "napisał", etc.) and trailing blank lines. Also handles
// Outlook-style "From:/Sent:" headers and "--- Forwarded message ---" banners.
export function stripQuotedReply(body) {
  if (!body) return body;
  const lines = body.split('\n');

  // 1. Find the first quote-prefixed line ("> ...")
  let firstQuoteIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*>/.test(lines[i])) { firstQuoteIdx = i; break; }
  }

  // 2. From there, walk back over the attribution + any blank padding
  let cutAt = firstQuoteIdx;
  if (firstQuoteIdx > 0) {
    // Look back up to 5 lines for the attribution / blank padding
    const attribRe = /\b(wrote|escribi[óo]|écrit|schrieb|napisa[lł]|skrev|scriss[ei])\b|写道|wrote:?\s*$|<[^>]+@[^>]+>\s*(?:于|у|on)/i;
    for (let i = firstQuoteIdx - 1; i >= Math.max(0, firstQuoteIdx - 6); i--) {
      const ln = lines[i];
      const isAttrib = attribRe.test(ln);
      const isBlank = ln.trim() === '';
      const isOnEnLine = /^On\s+\w+,?\s+\w+\s+\d{1,2}[,.]?\s+\d{2,4}/.test(ln);
      if (isAttrib || isBlank || isOnEnLine) cutAt = i;
      else break;
    }
  }

  // 3. Outlook-style header block — earliest such header wins. Supports:
  //    Latin: From/De/Van/Von + Sent/Date/Datum/Envoyé
  //    CJK:   发件人/寄件者/差出人/发信人 + 日期/时间/送信日時
  for (let i = 0; i < (cutAt >= 0 ? cutAt : lines.length) - 1; i++) {
    const ln  = lines[i] || '';
    const nxt = lines[i+1] || '';
    const isLatinFrom = /^(?:_+\s*)?\s*(?:From|De|Van|Von):\s*\S/.test(ln);
    const isLatinNext = /^\s*(?:Sent|Date|Datum|Envoy[ée]|Gesendet):/.test(nxt);
    // CJK "发件人:" or "发件人：" — full-width colon too. Often the very next
    // line is "日期:" or "收件人:" but sometimes everything is on one line.
    const isCjkFrom = /(?:发件人|发信人|寄件者|差出人|寄件人)\s*[:：]/.test(ln);
    if ((isLatinFrom && isLatinNext) || isCjkFrom) {
      if (cutAt < 0 || i < cutAt) cutAt = i;
      break;
    }
  }

  // 3b. Long divider line ("———————" / "======") followed within 3 lines by an
  // attribution header. Companies wrap forwarded headers in dashes — kill the
  // divider too so we don't end with a trailing "—————————" eyesore.
  for (let i = 0; i < (cutAt >= 0 ? cutAt : lines.length) - 1; i++) {
    const ln = lines[i] || '';
    if (!/^\s*[—=_-]{6,}\s*$/.test(ln)) continue;
    // Peek ahead 1-3 lines for a quote/from marker
    const ahead = (lines[i+1] || '') + ' ' + (lines[i+2] || '') + ' ' + (lines[i+3] || '');
    if (/(?:发件人|发信人|寄件者|差出人|From|De|Van|Von)\s*[:：]/.test(ahead) ||
        /\b(?:wrote|escribi[óo]|écrit|schrieb|napisa[lł]|skrev)\b|写道/.test(ahead)) {
      if (cutAt < 0 || i < cutAt) cutAt = i;
      break;
    }
  }

  // 4. Forwarded / original message banners
  for (let i = 0; i < (cutAt >= 0 ? cutAt : lines.length); i++) {
    if (/[-=]{2,}\s*(?:Forwarded message|Original Message|Mensaje original|Mensaje reenviado)/i.test(lines[i])) {
      if (cutAt < 0 || i < cutAt) cutAt = i;
      break;
    }
  }

  if (cutAt < 0) return body;  // No quote found — leave body alone
  return lines.slice(0, cutAt).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripHtml(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '')
             .replace(/<script[\s\S]*?<\/script>/gi, '')
             .replace(/<[^>]+>/g, ' ')
             .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
             .replace(/\s+/g, ' ').trim();
}

async function batchFetch(gmail, ids, concurrency = 8) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < ids.length) {
      const idx = i++;
      const id = ids[idx];
      try {
        const r = await gmail.users.messages.get({ userId:'me', id, format:'full' });
        out.push(r.data);
      } catch (e) {
        // skip individual failures, keep going
        console.warn(`gmail get ${id} failed:`, e.message);
      }
    }
  }
  await Promise.all(Array.from({length: concurrency}, worker));
  return out;
}
