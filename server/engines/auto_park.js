// auto_park.js — sweep open deals where the brand has gone silent for a while
// after multiple unanswered nudges, then quietly park them with a 60-day revisit.
//
// Why this exists: Riley's pipeline accumulates "we pitched, brand went heads-down,
// we sent 2 follow-ups, no reply" deals that should be on ice but stay in the
// active list polluting the forecast. The sweeper looks at the actual message
// history (brand silent + our follow-up count) and parks anything that matches
// without needing Riley to remember each one.
//
// Idempotent + cheap (single CTE + UPDATE), safe to call on every Pitches /
// this-week refresh. Returns the list of newly-parked deals so the UI can show
// "3 deals auto-parked — you'd already nudged + brand went silent" once.

// Conservative defaults — easy to tune later without re-deploying.
const DEFAULT_MIN_SILENT_DAYS = 14;     // brand hasn't replied in N days
const DEFAULT_MIN_OUR_NUDGES  = 2;      // we sent ≥N outbound after brand's last
const DEFAULT_PARK_DAYS_OUT   = 60;     // auto-revive after 60 days

export async function findAutoParkCandidates(db, opts = {}) {
  const minSilent  = opts.minSilentDays  ?? DEFAULT_MIN_SILENT_DAYS;
  const minNudges  = opts.minOurNudges   ?? DEFAULT_MIN_OUR_NUDGES;
  return await db.prepare(`
    WITH last_brand AS (
      SELECT t.deal_id, MAX(m.sent_at) AS brand_at
        FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE m.from_us = 0
       GROUP BY t.deal_id
    ),
    our_outbound_after AS (
      SELECT t.deal_id, COUNT(*) AS our_count
        FROM messages m JOIN threads t ON t.id = m.thread_id
        LEFT JOIN last_brand lb ON lb.deal_id = t.deal_id
       WHERE m.from_us = 1
         AND (lb.brand_at IS NULL OR m.sent_at > lb.brand_at)
       GROUP BY t.deal_id
    )
    SELECT d.id, d.brand, d.creator_id, d.raw_stage,
           CAST(julianday('now') - julianday(lb.brand_at) AS INT) AS days_silent,
           COALESCE(oo.our_count, 0) AS our_nudges,
           lb.brand_at AS last_brand_at
      FROM deals d
      JOIN last_brand lb ON lb.deal_id = d.id
      LEFT JOIN our_outbound_after oo ON oo.deal_id = d.id
     WHERE d.state = 'open'
       -- Don't auto-park signed/won deals or anything in active production.
       AND d.raw_stage NOT IN ('signed','contract_signed','contract_received','in_production','in_revision','terms_agreed')
       -- Only deals with actual message history (skips legacy migration deals)
       AND lb.brand_at IS NOT NULL
       AND julianday('now') - julianday(lb.brand_at) >= ?
       AND COALESCE(oo.our_count, 0) >= ?
     ORDER BY days_silent DESC
  `).all(minSilent, minNudges);
}

export async function autoParkStaleDeals(db, opts = {}) {
  const daysOut = opts.parkDaysOut ?? DEFAULT_PARK_DAYS_OUT;
  const candidates = await findAutoParkCandidates(db, opts);
  if (!candidates.length) return { parked: [], count: 0 };
  const revisit = new Date();
  revisit.setDate(revisit.getDate() + daysOut);
  const revisitISO = revisit.toISOString().slice(0, 10);
  const parkStmt = db.prepare(`
    UPDATE deals
       SET state = 'dormant',
           revisit_at = ?,
           park_reason = ?,
           parked_at = datetime('now'),
           revived_at = NULL,
           updated_at = datetime('now')
     WHERE id = ?
       AND state = 'open'`);
  const parked = [];
  for (const c of candidates) {
    const reason = `Auto-parked — brand silent ${c.days_silent} days after ${c.our_nudges} unanswered nudge${c.our_nudges === 1 ? '' : 's'}. Revisit ${revisitISO}.`;
    const r = await parkStmt.run(revisitISO, reason, c.id);
    if (r.changes) parked.push({ ...c, revisit_at: revisitISO, reason });
  }
  return { parked, count: parked.length };
}
