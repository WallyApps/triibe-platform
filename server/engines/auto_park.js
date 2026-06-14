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

// Ghost tier — brand never replied to our outbound pitch. Riley's rule:
// "brands that ghost me we should put into park as we can always come back
// later with different creators." Different defaults because ghosts are
// lower-promise — park longer so they don't crowd the Parked list every
// month and we genuinely give them air.
const DEFAULT_GHOST_SILENT_DAYS = 14;   // ≥N days since OUR last outbound and no brand reply
const DEFAULT_GHOST_PARK_DAYS   = 90;   // auto-revive after 90 days (longer than convo deaths)

// SQL filter — exclude OOO-classified messages so a brand that only auto-replied
// "out of office" counts as having NOT engaged. Classification is JSON-encoded
// in the column; we look for `"action_type":"ooo"` as a substring (avoids
// json_extract dependency, works across SQLite versions).
const NOT_OOO = `(m.classification IS NULL OR instr(m.classification, '"action_type":"ooo"') = 0)`;

export function findAutoParkCandidates(db, opts = {}) {
  const minSilent  = opts.minSilentDays  ?? DEFAULT_MIN_SILENT_DAYS;
  const minNudges  = opts.minOurNudges   ?? DEFAULT_MIN_OUR_NUDGES;
  return db.prepare(`
    WITH last_brand AS (
      SELECT t.deal_id, MAX(m.sent_at) AS brand_at
        FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE m.from_us = 0
         AND ${NOT_OOO}
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

// Ghost candidates — brand DID engage at some point (reached out, replied, or
// counter-pitched), then went silent. Distinct from findAutoParkCandidates only
// in that the nudge-count requirement is dropped — even a single quiet brand
// reply with no nudges back from us still qualifies for ghost-tier park.
//
// IMPORTANT: cold-outbound pitches the brand NEVER replied to are NOT parked.
// Those stay as cold leads; parking them is wrong because we never had a real
// conversation to come back from. Riley's rule: "parked shouldn't be brands i
// contacted and didnt get a response from. only brands we had responses from
// or reached out first that didn't end up replying down the line."
export function findGhostedCandidates(db, opts = {}) {
  const minSilent = opts.ghostSilentDays ?? DEFAULT_GHOST_SILENT_DAYS;
  return db.prepare(`
    WITH last_brand AS (
      SELECT t.deal_id, MAX(m.sent_at) AS brand_at, COUNT(*) AS brand_count
        FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE m.from_us = 0
         AND ${NOT_OOO}
       GROUP BY t.deal_id
    ),
    last_ours AS (
      SELECT t.deal_id, MAX(m.sent_at) AS ours_at, COUNT(*) AS our_count
        FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE m.from_us = 1
       GROUP BY t.deal_id
    )
    SELECT d.id, d.brand, d.creator_id, d.raw_stage,
           COALESCE(lo.our_count, 0) AS our_count,
           COALESCE(lb.brand_count, 0) AS brand_count,
           CAST(julianday('now') - julianday(lb.brand_at) AS INT) AS days_silent,
           lb.brand_at AS last_brand_at
      FROM deals d
      JOIN last_brand lb ON lb.deal_id = d.id
      LEFT JOIN last_ours lo  ON lo.deal_id = d.id
     WHERE d.state = 'open'
       AND d.raw_stage NOT IN ('signed','contract_signed','contract_received','in_production','in_revision','terms_agreed')
       -- Brand DID engage (at least one real, non-OOO message). Cold-outbound
       -- pitches with zero brand reply are intentionally excluded here.
       AND lb.brand_at IS NOT NULL
       -- Silent at least minSilent days since brand's last real message
       AND julianday('now') - julianday(lb.brand_at) >= ?
       -- Don't double-count Tier A — only ghost the deals where we sent FEWER
       -- nudges than findAutoParkCandidates requires (otherwise Tier A handles it).
       AND COALESCE(lo.our_count, 0) < ?
     ORDER BY days_silent DESC
  `).all(minSilent, opts.minOurNudges ?? DEFAULT_MIN_OUR_NUDGES);
}

export function autoParkStaleDeals(db, opts = {}) {
  const daysOut = opts.parkDaysOut ?? DEFAULT_PARK_DAYS_OUT;
  const ghostDaysOut = opts.ghostParkDays ?? DEFAULT_GHOST_PARK_DAYS;
  // Tier A — conversation died (brand replied, then went silent after our nudges)
  const candidates = findAutoParkCandidates(db, opts);
  // Tier B — brand ghosted (never replied to our outbound pitch)
  const ghosts = findGhostedCandidates(db, opts);
  if (!candidates.length && !ghosts.length) return { parked: [], count: 0 };
  const revisit = new Date();      revisit.setDate(revisit.getDate() + daysOut);
  const revisitISO = revisit.toISOString().slice(0, 10);
  const ghostRevisit = new Date(); ghostRevisit.setDate(ghostRevisit.getDate() + ghostDaysOut);
  const ghostRevisitISO = ghostRevisit.toISOString().slice(0, 10);
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
    const r = parkStmt.run(revisitISO, reason, c.id);
    if (r.changes) parked.push({ ...c, revisit_at: revisitISO, reason, tier: 'conversation' });
  }
  for (const g of ghosts) {
    // Ghost tier now requires brand engagement (≥1 real reply) — so all rows
    // here describe a conversation that started then died. Phrasing varies by
    // how many follow-ups we sent before they vanished.
    const reason = g.our_count === 0
      ? `Brand reached out, we never replied — silent ${g.days_silent}d. Revisit ${ghostRevisitISO} or kill.`
      : g.our_count === 1
      ? `Conversation died — brand replied once then went silent ${g.days_silent}d ago. Revisit ${ghostRevisitISO} — try a different creator angle.`
      : `Conversation died — brand silent ${g.days_silent}d after our ${g.our_count} follow-ups. Revisit ${ghostRevisitISO} — try a different creator angle.`;
    const r = parkStmt.run(ghostRevisitISO, reason, g.id);
    if (r.changes) parked.push({ ...g, revisit_at: ghostRevisitISO, reason, tier: 'ghosted' });
  }
  return { parked, count: parked.length };
}
