// creator_chat_propagator.js — bridge the COOPER × TRIIBE / CHARLIE × TRIIBE
// WhatsApp threads to the per-deal audit + summary refresh pipeline.
//
// Background: the WA daemon writes creator-chat messages directly to SQLite.
// Those threads aren't linked to any deal_id, so the existing /api/sync logic
// that queues a lifecycle audit when a deal's last_activity_at moves never
// fires for "Cooper says Sintra signed" style messages. This propagator runs
// on a 30s tick, finds fresh creator-chat messages, matches them against the
// brand names of every open deal, and for each match:
//   1. bumps the deal's last_activity_at  (so AI summary cache invalidates)
//   2. nulls ai_summary_for                (forces summary regen on next fetch)
//   3. queues a lifecycle audit            (so the verdict re-runs)
//
// Net effect: Cooper texting Riley about a brand instantly propagates to that
// deal's pill — the platform updates on its own, no manual nudge needed.

import { queueAudit } from './lifecycle_audit.js';

// Same token rules as lifecycle_audit.js — split brand name on common
// separators, drop short tokens and obvious noise words. A creator-chat
// message that contains ANY of a deal's tokens is treated as a match for that
// deal.
const STOP = new Set([
  'the','and','agent','co','app','inc','tiktok','youtube','reel','via',
  'team','direct','com','net','llc','group','media','studio','studios',
]);

function brandTokens(brand) {
  if (!brand) return [];
  return [...new Set(
    brand.toLowerCase()
      .split(/[\s/()\-—–,.]+/)
      .map(t => t.trim())
      .filter(t => t.length >= 4 && !STOP.has(t))
  )];
}

// Track the high-water mark across ticks so we don't re-process the same msgs.
// Keeps tens of bytes in memory — fine.
let lastSeenAt = null;

export function tickPropagator({ db, apiKey, spend }) {
  if (!db) return { matched: 0, reason: 'no db' };

  // On first tick after boot, seed from the most recent creator-chat message
  // so we don't re-process the full backlog. Subsequent ticks march forward.
  if (lastSeenAt == null) {
    const seed = db.prepare(`SELECT MAX(m.sent_at) m
      FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE t.channel='whatsapp' AND t.subject LIKE '%X TRIIBE%'`).get();
    lastSeenAt = seed?.m || new Date(Date.now() - 60_000).toISOString();
    return { matched: 0, reason: 'seeded' };
  }

  // Fetch creator-chat messages newer than our high-water mark.
  const rows = db.prepare(`
    SELECT m.id, m.sent_at, m.body, m.snippet, m.from_us, t.subject
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE t.channel='whatsapp' AND t.subject LIKE '%X TRIIBE%'
      AND m.sent_at > ?
    ORDER BY m.sent_at ASC
  `).all(lastSeenAt);

  if (!rows.length) return { matched: 0, reason: 'no new msgs' };

  // Pull active deals once per tick + memoize their tokenized brand names.
  const deals = db.prepare(`
    SELECT id, brand, creator_id, fee_cents, posting_date, funnel_stage,
           raw_stage, state, payment_terms_days
    FROM deals
    WHERE state != 'lost'
      AND funnel_stage NOT IN ('cold','dormant')
  `).all();
  const dealTokens = deals.map(d => ({ deal: d, tokens: brandTokens(d.brand) }));

  // Match each message to creator (from the chat subject) → only consider that
  // creator's deals. Avoids Cooper's chat triggering Charlie's deals.
  let matched = 0;
  const touched = new Set();
  for (const row of rows) {
    const text = (row.body || row.snippet || '').toLowerCase();
    if (!text) continue;
    const subj = (row.subject || '').toUpperCase();
    const creator = subj.includes('COOPER') ? 'cooper'
                  : subj.includes('CHARLIE') ? 'charlie' : null;
    if (!creator) continue;

    for (const { deal, tokens } of dealTokens) {
      if (deal.creator_id !== creator) continue;
      if (!tokens.length) continue;
      const hit = tokens.some(tok => text.includes(tok));
      if (!hit) continue;
      if (touched.has(deal.id)) continue;
      touched.add(deal.id);

      // 1. Bump activity timestamp so freshness consumers (AI summary cache,
      //    "where we are" prompts) treat the deal as just-touched.
      // 2. Null ai_summary_for so /api/deals/:id/summary regenerates against
      //    the new context next time it's fetched.
      try {
        db.prepare(`UPDATE deals
          SET last_activity_at = ?, ai_summary_for = NULL
          WHERE id = ?`).run(row.sent_at, deal.id);
      } catch (e) {
        console.warn(`[creator_chat_propagator] ${deal.id} bump err:`, e.message);
      }

      // 3. Queue a lifecycle audit. The audit's own 30s debounce coalesces
      //    bursts so we don't pay for 10 audits if Cooper sends 10 msgs in
      //    a row.
      if (apiKey) {
        try { queueAudit({ db, deal, apiKey, spend }); }
        catch (e) { console.warn(`[creator_chat_propagator] ${deal.id} queue err:`, e.message); }
      }
      matched++;
    }
    lastSeenAt = row.sent_at;
  }

  if (matched) {
    console.log(`[creator_chat_propagator] propagated ${matched} creator-chat hits to deals`);
  }
  return { matched, scanned: rows.length, touched: touched.size };
}

// 30s tick — short enough that creator-chat updates feel near-real-time,
// long enough that we don't hammer the DB when nothing is happening.
export function startPropagator({ db, apiKey, spend }) {
  setInterval(() => {
    try { tickPropagator({ db, apiKey, spend }); }
    catch (e) { console.warn('[creator_chat_propagator] tick err:', e.message); }
  }, 30_000);
  console.log('[creator_chat_propagator] started — 30s tick');
}
