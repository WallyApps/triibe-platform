// tools/ingest-brian.mjs — one-off backfill for Brian Wallack's inbound.
//
// The classifier didn't know Brian existed until today, so any forwarded brand
// emails from bwallsocialmedia@gmail.com that the platform pulled previously
// either got tagged as 'unknown' (and ignored) or 'cooper' (wrong).
//
// This script:
//   1. Triggers a wider Gmail pull (14 days vs the 2d default in /api/sync)
//      to make sure every forwarded Brian email is in the threads/messages table.
//   2. Marks any thread that looks Brian-shaped (sender/snippet contains
//      bwallsocialmedia, brianwallack, BWALL, or "Brian Wallack") as
//      pitch_creator='brian'. The next /api/inbox-pitches refresh will then
//      route them into Brian's Pitches view automatically.
//
// Run with: node tools/ingest-brian.mjs
// Re-runnable — idempotent for both the pull (upserts) and the SQL (only
// re-tags threads that match the pattern).

import { openDb } from '../db/init.js';
import { GmailInboundProvider, hasToken } from '../server/providers/inbound.gmail.js';

const db = openDb();

console.log('=== Brian Wallack inbound backfill ===');
console.log();

// --- 1. Pull last 14 days of Gmail inbox + sent ----------------------------
if (!hasToken()) {
  console.error('Gmail OAuth not set up. Cannot pull. Aborting.');
  process.exit(1);
}
const provider = new GmailInboundProvider(db);
console.log('Pulling Gmail (newer_than:14d, inbox+sent)…');
const result = await provider.pull({
  query: 'newer_than:14d (in:inbox OR in:sent)',
  maxResults: 200,
});
console.log('  →', JSON.stringify(result));
console.log();

// --- 2. Backfill pitch_creator='brian' on matching threads -----------------
// Pattern: any thread where the subject or last_snippet contains
// bwallsocialmedia (Brian's gmail forwarder), brianwallack (his handle),
// BWALL (his YouTube channel), or "Brian Wallack" / "Brian " salutation.
const before = db.prepare(`SELECT COUNT(*) AS n FROM threads WHERE pitch_creator='brian'`).get();
console.log(`Threads currently tagged brian: ${before.n}`);

const result2 = db.prepare(`
  UPDATE threads
     SET pitch_creator = 'brian',
         pitch_classified_at = datetime('now')
   WHERE channel = 'email'
     AND (
          subject     LIKE '%brianwallack%'         OR
          subject     LIKE '%Brian Wallack%'        OR
          subject     LIKE '%BWALL%'                OR
          subject     LIKE 'Fwd:%'                  OR  -- nearly all of Brian's go through forwards
          last_snippet LIKE '%bwallsocialmedia%'    OR
          last_snippet LIKE '%brianwallack%'        OR
          last_snippet LIKE '%Brian Wallack%'       OR
          last_snippet LIKE 'Hi Brian%'             OR
          last_snippet LIKE 'Hey Brian%'            OR
          last_snippet LIKE 'Hello Brian%'
     )
     AND (pitch_creator IS NULL OR pitch_creator IN ('unknown','cooper'))
`).run();
console.log(`  → ${result2.changes} threads newly tagged as brian`);

const after = db.prepare(`SELECT COUNT(*) AS n FROM threads WHERE pitch_creator='brian'`).get();
console.log(`Threads now tagged brian: ${after.n}`);
console.log();

// --- 3. Show what we tagged ------------------------------------------------
const sample = db.prepare(`
  SELECT id, substr(subject, 1, 70) AS subj, substr(last_snippet, 1, 60) AS snip
  FROM threads
  WHERE pitch_creator = 'brian'
  ORDER BY last_message_at DESC
  LIMIT 15
`).all();
console.log('Brian-tagged threads (top 15 by recency):');
for (const t of sample) {
  console.log(`  ${t.id}  ${t.subj || '(no subj)'}`);
}
console.log();
console.log('Done. Refresh the Pitches tab on Brian — these threads will appear there.');
