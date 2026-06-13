// forecaster.js — rolling-90d strategic plan for a creator.
//
// Inputs: every active deal + their close-rate scores + key dates.
// Outputs:
//   - weekly_slots: open vs. occupied posting windows for the next 13 weeks
//   - sequenced_plan: top-EV pending deals assigned to open slots respecting
//     exclusivity clashes
//   - rolled_ev: expected value over the horizon (fee × p_close per deal)
//   - by_month: month-bucketed summary so the UI can show "July $9.2K EV"
//
// Cached on /api/sync + every 10 min so the Money tab loads instantly.

import { scoreDeals } from './close_rate.js';
import { parseNegotiation } from './negotiation.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
let _rateCard = null;
function rateCard() {
  if (_rateCard) return _rateCard;
  try {
    _rateCard = JSON.parse(readFileSync(join(__dirname, '../../config/rate_card.json'), 'utf8'));
  } catch { _rateCard = {}; }
  return _rateCard;
}
// Hard universal floor when no creator-specific value is set. Below this is
// almost always parsing noise (catches "$50 ad spend" or "$200 budget" mentions).
const HARD_FLOOR_CENTS = 100000;
function floorFor(creator) {
  return rateCard()[creator]?.floor_cents ?? HARD_FLOOR_CENTS;
}

const DAY_MS = 86_400_000;
const HORIZON_DAYS = 90;
const WEEKS = Math.ceil(HORIZON_DAYS / 7);

/**
 * Build the rolling 13-week slot grid for a creator. Marks slots occupied
 * when a confirmed deal has its posting_date inside that week.
 */
async function buildSlots(db, creator) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  // Roll back to Monday so weeks are clean
  const dow = start.getDay();
  start.setDate(start.getDate() - ((dow + 6) % 7));
  const slots = [];
  for (let w = 0; w < WEEKS; w++) {
    const ws = new Date(start.getTime() + w * 7 * DAY_MS);
    const we = new Date(ws.getTime() + 7 * DAY_MS - 1);
    slots.push({
      week_index: w,
      week_start: ws.toISOString().slice(0, 10),
      week_end:   we.toISOString().slice(0, 10),
      occupied:   false,
      occupied_by: null,
      occupied_fee_cents: 0,
    });
  }

  // Mark slots occupied by confirmed deals with a posting_date
  const booked = await db.prepare(`
    SELECT id, brand, fee_cents, posting_date, category
    FROM deals
    WHERE creator_id = ?
      AND state IN ('won','open')
      AND posting_date IS NOT NULL
      AND posting_date >= ?
      AND posting_date <= ?
  `).all(creator, slots[0].week_start, slots[slots.length - 1].week_end);

  for (const b of booked) {
    const target = new Date(b.posting_date + 'T00:00:00Z').getTime();
    const slot = slots.find(s =>
      target >= new Date(s.week_start + 'T00:00:00Z').getTime() &&
      target <= new Date(s.week_end + 'T23:59:59Z').getTime()
    );
    if (!slot) continue;
    // Stack multiple bookings in the same week (Velo Jun 23 + Combos Jun 25 →
    // both visible). Single-slot fields point at the FIRST booking for backward
    // compat with the existing sequencer + banner; the bookings array is the
    // source of truth for callers that want all of them.
    if (!slot.bookings) slot.bookings = [];
    slot.bookings.push({
      deal_id: b.id, brand: b.brand,
      fee_cents: b.fee_cents || 0, category: b.category,
      posting_date: b.posting_date,
    });
    if (!slot.occupied) {
      slot.occupied = true;
      slot.occupied_by = b.brand;
      slot.occupied_fee_cents = b.fee_cents || 0;
      slot.occupied_deal_id = b.id;
      slot.occupied_category = b.category;
    } else {
      // Second+ booking in the same week — sum fees into the slot total so
      // confirmed_cents / by_month math reflects all bookings, not just the first.
      slot.occupied_fee_cents = (slot.occupied_fee_cents || 0) + (b.fee_cents || 0);
    }
  }
  return slots;
}

/**
 * Sequence pending deals into open slots greedily by EV (fee × p_close).
 * Respects category-level exclusivity clashes: if two deals share the same
 * category, they're spaced at least 1 week apart in Cooper's calendar.
 */
function sequence(slots, scoredDeals, creatorFloor = 100000) {
  // EV-sorted unassigned deals — but exclude anything below the creator's
  // realistic rate floor. CapCut at $150 or BrandSearch at $400 are either
  // stale legacy fees or parser noise (regex caught a passing "$X" mention).
  // Sequencing them would burn a real posting slot on a deal we'd never take.
  // The Pipeline-ranked list still shows them (separate tag), this only
  // controls what goes on the calendar.
  const candidates = scoredDeals
    .filter(d => (d.fee_cents || 0) >= creatorFloor)
    .map(d => ({ ...d, ev_cents: Math.round((d.fee_cents || 0) * d.p_close) }))
    .sort((a, b) => b.ev_cents - a.ev_cents);

  const assignments = [];
  for (const c of candidates) {
    // Find earliest open slot that doesn't clash on category
    const idx = slots.findIndex((s, i) => {
      if (s.occupied) return false;
      // Category clash check: same category within ±1 week of an occupied slot
      if (c.category) {
        const adjOccupied = slots.slice(Math.max(0, i-1), i+2)
          .some(adj => adj.occupied_category === c.category);
        if (adjOccupied) return false;
      }
      // Also clash against already-assigned slots
      const adjAssigned = assignments.find(a =>
        a.category && a.category === c.category
        && Math.abs(a.week_index - i) <= 1
      );
      if (adjAssigned) return false;
      return true;
    });
    if (idx < 0) continue;  // pipeline overflows the horizon, skip
    slots[idx].occupied = true;
    slots[idx].occupied_by = `${c.brand} (projected)`;
    slots[idx].occupied_fee_cents = c.fee_cents || 0;
    slots[idx].occupied_category = c.category;
    slots[idx].projected = true;
    slots[idx].projected_deal_id = c.id;
    slots[idx].projected_p_close = c.p_close;
    slots[idx].projected_ev_cents = c.ev_cents;
    assignments.push({
      week_index: idx,
      week_start: slots[idx].week_start,
      deal_id: c.id,
      brand: c.brand,
      fee_cents: c.fee_cents,
      our_quote_cents: c.our_quote_cents ?? null,
      brand_counter_cents: c.brand_counter_cents ?? null,
      brand_accepted: !!c.brand_accepted,
      p_close: c.p_close,
      ev_cents: c.ev_cents,
      category: c.category,
    });
  }
  return assignments;
}

/**
 * Compute the full 90-day strategic plan for one creator.
 * @returns { slots, plan, totals, by_month, scored_pending }
 */
export async function forecast(db, creator) {
  // 1. Build calendar slot grid + mark confirmed bookings
  const slots = await buildSlots(db, creator);

  // 2. Pull every pending deal that could potentially close in horizon.
  // Exclude deals that ALREADY have a posting_date — those are surfaced as
  // confirmed bookings via buildSlots() above, double-counting them in the
  // sequencer would inflate projected EV + cause the same brand to appear
  // twice (once "Jul 9 confirmed", once "Aug 24 projected").
  const pending = await db.prepare(`
    SELECT id, brand, contact_name, fee_cents, posting_date, category,
           raw_stage, ball_in_court, state, last_activity_at
    FROM deals
    WHERE creator_id = ?
      AND state IN ('open')
      AND funnel_stage IN ('pitching','in_works','active','conversation')
      AND (fee_cents IS NULL OR fee_cents > 0)
      AND posting_date IS NULL
  `).all(creator);

  // 3. For each pending deal, replace stale fee_cents with the REALISTIC fee
  // parsed from the actual conversation (OUR pitch + BRAND counter → blended).
  // Preserves the original ask in `our_quote_cents` so the UI can still show
  // "we pitched $X, brand at $Y, realistic close $Z" if needed.
  const realistic = await Promise.all(pending.map(async d => {
    const neg = await parseNegotiation(db, d);
    return {
      ...d,
      our_quote_cents: neg.our_quote_cents,
      brand_counter_cents: neg.brand_counter_cents,
      brand_accepted: neg.brand_accepted,
      // Substitute fee_cents so the downstream EV / scoring math uses the
      // honest number. Fall back to original fee_cents if parser found nothing.
      fee_cents: neg.realistic_fee_cents ?? d.fee_cents,
    };
  }));

  // 4. Score every pending deal's close probability
  const scored = await scoreDeals(db, realistic);
  // Tag below-floor deals so the UI can flag them as "likely stale / parser
  // noise" without burning them from the visible pipeline.
  const creatorFloor = floorFor(creator);
  for (const s of scored) {
    s.below_floor = (s.fee_cents || 0) < creatorFloor;
  }

  // 5. Sequence them into open slots greedily by EV (skips below-floor)
  const plan = sequence(slots, scored, creatorFloor);

  // 5. Aggregate totals
  const horizonStart = new Date(slots[0].week_start);
  const horizonEnd   = new Date(slots[slots.length - 1].week_end + 'T23:59:59Z');
  const confirmedCents = slots
    .filter(s => s.occupied && !s.projected)
    .reduce((acc, s) => acc + (s.occupied_fee_cents || 0), 0);
  const projectedCents = plan.reduce((acc, a) => acc + a.ev_cents, 0);
  const total_ev_cents = confirmedCents + projectedCents;

  // 6. By-month breakdown so the UI can show monthly EV chips
  const monthBuckets = {};
  for (const s of slots) {
    const ym = s.week_start.slice(0, 7);  // "2026-07"
    if (!monthBuckets[ym]) monthBuckets[ym] = { month: ym, confirmed_cents: 0, projected_ev_cents: 0, open_slots: 0 };
    if (s.occupied && !s.projected) monthBuckets[ym].confirmed_cents   += (s.occupied_fee_cents || 0);
    if (s.projected)                monthBuckets[ym].projected_ev_cents += (s.projected_ev_cents || 0);
    if (!s.occupied)                monthBuckets[ym].open_slots++;
  }

  return {
    creator,
    horizon: { start: horizonStart.toISOString().slice(0,10), end: horizonEnd.toISOString().slice(0,10), weeks: WEEKS },
    slots,
    plan,
    totals: {
      confirmed_cents: confirmedCents,
      projected_ev_cents: projectedCents,
      total_ev_cents,
      sequenced_deals: plan.length,
      pending_pool_size: pending.length,
    },
    by_month: Object.values(monthBuckets).sort((a, b) => a.month.localeCompare(b.month)),
    scored_pending: scored.map(s => ({
      deal_id: s.id, brand: s.brand, fee_cents: s.fee_cents,
      // Both sides of the table — UI shows them side-by-side when they differ
      // ("you: $2K · them: $500") instead of a fabricated midpoint.
      our_quote_cents: s.our_quote_cents ?? null,
      brand_counter_cents: s.brand_counter_cents ?? null,
      brand_accepted: !!s.brand_accepted,
      p_close: s.p_close, ev_cents: Math.round((s.fee_cents||0) * s.p_close),
      raw_stage: s.raw_stage, ball_in_court: s.ball_in_court,
      below_floor: !!s.below_floor,
    })).sort((a, b) => b.ev_cents - a.ev_cents),
    computed_at: new Date().toISOString(),
  };
}
