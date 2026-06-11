// Pricing engine — given a deal (+ optional brand counter), suggest a price
// that respects Riley's floors and anchors 25-50% above the floor. Encodes
// the negotiation playbook so the local stub and OpenAI provider both end up
// in the same ballpark.

// All values in CENTS (matches the schema). Easy to edit later.
export const RATES = {
  cooper: {
    floor:    200000, // $2,000 — 1 dedicated IG Reel organic only
    standard: 300000, // $3,000
    repurpose:400000, // $4,000 IG+TT
    repurpose_max: 500000,
    story_addon: 60000, // +$500-750
    paid_amp_30: 0.5,   // +50% for 30-day whitelisting
    paid_amp_90: 1.0,
  },
  charlie: {
    floor:    450000, // $4,500 IG Reel + 30-day link in bio (Dexnor anchor)
    standard: 600000, // $6,000
    ig_tt_pack: 650000, // $6,500 TikTok + IG package
    tt_only:  250000, // $2,500
    cinematic_min: 350000,
    cinematic_max: 450000,
    story_addon: 100000,
  },
  hard_floor_global: 100000, // $1,000 — anything below escalates to Riley
};

export function suggestPrice(deal, { brandOffer = null } = {}) {
  const c = deal.creator_id;
  const r = RATES[c];
  if (!r) {
    return { suggested_cents: null, floor_cents: RATES.hard_floor_global,
             anchor_cents: null, note: 'No rate card for this creator yet — set in pricing.js.',
             reasoning: 'unknown creator' };
  }

  const floor = r.floor;
  const anchor = Math.round(r.standard * 1.0); // standard IS the anchor for opening replies
  let suggested;
  let note;
  let reasoning;

  if (brandOffer == null) {
    suggested = anchor;
    note = `anchor at our standard. Leaves room to land around ${fmtUsd(r.standard)}-${fmtUsd(Math.round(r.standard * 0.85))}.`;
    reasoning = `Opening anchor 50% above floor (${fmtUsd(floor)}).`;
  } else if (brandOffer < floor) {
    // Counter back to floor + 25-50% buffer; never accept below floor.
    suggested = Math.round((floor + r.standard) / 2);
    note = `their offer ${fmtUsd(brandOffer)} is under your floor — counter back firmly.`;
    reasoning = `Brand below floor — counter to midpoint of floor and standard.`;
  } else if (brandOffer < r.standard) {
    suggested = Math.round((brandOffer + r.standard) / 2);
    note = `meet them halfway between their ${fmtUsd(brandOffer)} and standard.`;
    reasoning = `Brand in band — split-the-difference, preserve ${fmtUsd(suggested - brandOffer)} upside.`;
  } else {
    suggested = brandOffer;
    note = `their offer is at or above standard — accept and lock terms.`;
    reasoning = `Brand at/above standard — take it.`;
  }

  const flagsLow = (deal.flags || []).join(' ').toLowerCase();
  const escalate = [];
  if (deal.exclusivity_days >= 90 || /perpetual/.test(flagsLow + ' ' + (deal.usage_rights || '').toLowerCase())) {
    escalate.push('perpetual_or_long_exclusivity');
  }
  if (suggested < RATES.hard_floor_global) escalate.push('below_$1000_hard_floor');

  return {
    suggested_cents: suggested,
    floor_cents: floor,
    anchor_cents: anchor,
    brand_offer_cents: brandOffer,
    note,
    reasoning,
    escalate, // non-empty => UI flags "review before draft"
  };
}

function fmtUsd(c) { return c == null ? '—' : '$' + Math.round(c/100).toLocaleString(); }
