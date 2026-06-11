// Thread ingest — pulls Gmail thread headers + WhatsApp full messages from
// the existing ~/triibe-ops snapshot files (READ-ONLY; we never write back).
//
//   Gmail   : ~/triibe-ops/data/threads_snapshot.json
//             { fetched_at, threads: { <tid>: { messages: [{id,date,sender,labelIds}] } } }
//             -- bodies NOT available from this file (MINIMAL format).
//             Bodies require Gmail API/MCP — separate ingest layer.
//
//   WhatsApp: ~/triibe-ops/data/whatsapp/live.json  (FULL bodies)
//             { pulled_at, chats: [{ id, name, ball_in_court, messages:[{from_me,ts,body,type}] }] }
//             ~/triibe-ops/data/wa_map.json — maps chat-name substring -> deal_id

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const TRIIBE_OPS = '/Users/rileywallack/triibe-ops';
const OUR_DOMAINS = ['@triibetalents.com'];
const OUR_EMAILS  = ['cooper@theactionableai.com'];

const senderIsUs = sender => {
  const s = (sender || '').toLowerCase();
  return OUR_DOMAINS.some(d => s.includes(d)) || OUR_EMAILS.some(e => s.includes(e));
};
const sha = s => createHash('sha1').update(s).digest('hex').slice(0, 16);

export function ingestAll(db) {
  const stats = { gmail: ingestGmail(db), whatsapp: ingestWhatsApp(db) };
  // Update per-deal last_message_at from latest message in either channel.
  db.exec(`
    UPDATE deals SET last_activity_at = COALESCE((
      SELECT MAX(sent_at) FROM messages m
      JOIN threads t ON t.id = m.thread_id
      WHERE t.deal_id = deals.id
    ), last_activity_at)
  `);
  return stats;
}

function ingestGmail(db) {
  const path = `${TRIIBE_OPS}/data/threads_snapshot.json`;
  if (!existsSync(path)) return { threads: 0, messages: 0, skipped: 'no snapshot' };
  const snap = JSON.parse(readFileSync(path, 'utf8'));
  const threadsObj = snap.threads || {};
  // Build thread_id -> deal_id index from deals.thread_id
  const dealByThread = Object.fromEntries(
    db.prepare(`SELECT id, thread_id FROM deals WHERE thread_id IS NOT NULL`).all()
      .map(r => [r.thread_id, r.id])
  );

  const upsertThread = db.prepare(`
    INSERT INTO threads (id, deal_id, channel, last_message_at, last_message_by, ball_in_court, updated_at)
    VALUES (?, ?, 'email', ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET deal_id=excluded.deal_id,
      last_message_at=excluded.last_message_at, last_message_by=excluded.last_message_by,
      ball_in_court=excluded.ball_in_court, updated_at=datetime('now')`);
  const insertMsg = db.prepare(`
    INSERT INTO messages (id, thread_id, channel, sender, from_us, sent_at, snippet, raw_hash)
    VALUES (?, ?, 'email', ?, ?, ?, NULL, ?)
    ON CONFLICT(id) DO NOTHING`);

  let nThreads = 0, nMessages = 0;
  for (const [tid, t] of Object.entries(threadsObj)) {
    const msgs = (t.messages || []).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    if (!msgs.length) continue;
    const last = msgs[msgs.length - 1];
    const lastUs = senderIsUs(last.sender);
    upsertThread.run(tid, dealByThread[tid] || null, last.date, lastUs ? 'us' : 'them',
                     lastUs ? 'them' : 'us');
    nThreads++;
    for (const m of msgs) {
      insertMsg.run(m.id, tid, m.sender || null, senderIsUs(m.sender) ? 1 : 0,
        m.date || null, sha(`gm:${m.id}:${m.date}:${m.sender}`));
      nMessages++;
    }
  }
  return { threads: nThreads, messages: nMessages, bodies: 'headers-only (need Gmail API for bodies)' };
}

function ingestWhatsApp(db) {
  const livePath = `${TRIIBE_OPS}/data/whatsapp/live.json`;
  const mapPath  = `${TRIIBE_OPS}/data/wa_map.json`;
  if (!existsSync(livePath)) return { threads: 0, messages: 0, skipped: 'no live.json' };
  const live = JSON.parse(readFileSync(livePath, 'utf8'));
  const map = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, 'utf8')) : { brand_chats: {} };
  const brandChats = map.brand_chats || {};

  // Match each chat name to a deal_id via substring of brand_chats keys.
  const matchDeal = chatName => {
    const lc = (chatName || '').toLowerCase();
    for (const [substr, deal_id] of Object.entries(brandChats)) {
      if (lc.includes(substr.toLowerCase())) return deal_id;
    }
    return null;
  };

  const upsertThread = db.prepare(`
    INSERT INTO threads (id, deal_id, channel, subject, last_message_at, last_message_by, ball_in_court, updated_at)
    VALUES (?, ?, 'whatsapp', ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET deal_id=excluded.deal_id, subject=excluded.subject,
      last_message_at=excluded.last_message_at, last_message_by=excluded.last_message_by,
      ball_in_court=excluded.ball_in_court, updated_at=datetime('now')`);
  const insertMsg = db.prepare(`
    INSERT INTO messages (id, thread_id, channel, sender, from_us, sent_at, snippet, body, raw_hash)
    VALUES (?, ?, 'whatsapp', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING`);

  let nThreads = 0, nMessages = 0, mapped = 0, unmapped = [];
  for (const chat of (live.chats || [])) {
    const threadId = `wa:${chat.id || chat.name}`;
    const dealId = matchDeal(chat.name);
    if (dealId) mapped++; else unmapped.push(chat.name);
    const msgs = (chat.messages || []).slice().sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    if (!msgs.length) continue;
    const last = msgs[msgs.length - 1];
    upsertThread.run(threadId, dealId, chat.name, last.ts,
                     last.from_me ? 'us' : 'them',
                     last.from_me ? 'them' : 'us');
    nThreads++;
    for (const m of msgs) {
      const mid = `wa:${threadId}:${sha(`${m.ts}:${m.body || ''}:${m.from_me}`)}`;
      const body = m.body || '';
      const snippet = body.slice(0, 120);
      insertMsg.run(mid, threadId, m.from_me ? 'us' : (chat.name || 'brand'),
        m.from_me ? 1 : 0, m.ts || null, snippet, body, mid);
      nMessages++;
    }
  }
  return { threads: nThreads, messages: nMessages, mapped, unmapped_chats: unmapped };
}
