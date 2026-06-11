// close_score.js — rank pending negotiations by close-ability so Riley
// knows which deals to push TODAY to maximize $ closed in shortest window.
//
// Different from fit-score (which decides whether to PURSUE a brand). This
// decides among brands you're already negotiating with: who's closest to yes,
// who's worth the energy, who's a clash risk, who's cooling and needs a push.
//
// Score is 1-10 (10 = close this today). Reasons are short, actionable phrases
// ordered by impact — top reason is the headline shown on the pill.

const DAY = 86400000;

/**
 * @param {object} deal     — full deal row (must include exclusivity_terms, category, fee_cents, raw_stage)
 * @param {object} negData  — { our_quote_cents, brand_counter_cents, counter_delta_pct, latest_brand_at }
 * @param {object} ctx      — { db, allActiveDeals, creatorId }
 * @returns { score, reasons, headline, blocked }
 */
export function computeCloseScore({ deal, negData = {}, ctx }) {
  let score = 50;
  const reasons = [];
  let blocked = false;

  const ourCents     = negData.our_quote_cents ?? deal.fee_cents ?? null;
  const counterCents = negData.brand_counter_cents ?? null;
  const deltaPct     = negData.counter_delta_pct ?? null;
  const latestBrand  = negData.latest_brand_at ?? deal.last_activity_at ?? null;
  const daysQuiet    = latestBrand ? Math.floor((Date.now() - new Date(latestBrand).getTime()) / DAY) : 99;

  // -------------------------------------------------------------------------
  // (1) MONEY ON THE TABLE — what's actually in motion (up to +30)
  // -------------------------------------------------------------------------
  if (counterCents != null && deltaPct != null) {
    const counterUSD = Math.round(counterCents/100).toLocaleString();
    if (deltaPct >= 50)      { score += 35; reasons.push({ kind:'money', txt: `🎯 Brand offered \$${counterUSD} — MUCH higher than ask, ACCEPT NOW`, pos:true, critical:true }); }
    else if (deltaPct >= 0)  { score += 30; reasons.push({ kind:'money', txt: `Brand offered \$${counterUSD} — at or above our ask`, pos:true, critical:true }); }
    else if (deltaPct >= -10){ score += 25; reasons.push({ kind:'money', txt: `Brand \$${counterUSD} — ${Math.abs(deltaPct)}% below ask, very close-able`, pos:true }); }
    else if (deltaPct >= -25){ score += 15; reasons.push({ kind:'money', txt: `Brand \$${counterUSD} — ${Math.abs(deltaPct)}% below, close-able`, pos:true }); }
    else if (deltaPct >= -50){ score += 0;  reasons.push({ kind:'money', txt: `Brand \$${counterUSD} — ${Math.abs(deltaPct)}% below, meet in middle?`, pos:false }); }
    else                     { score -= 20; reasons.push({ kind:'money', txt: `Brand \$${counterUSD} — ${Math.abs(deltaPct)}% below, likely walk-away`, pos:false }); }
  } else if (ourCents) {
    if (ourCents >= 400000)      { score += 20; reasons.push({ kind:'money', txt: `$${(ourCents/100).toLocaleString()} on the table`, pos:true }); }
    else if (ourCents >= 200000) { score += 12; reasons.push({ kind:'money', txt: `$${(ourCents/100).toLocaleString()} quoted`, pos:true }); }
    else if (ourCents >= 50000)  { score += 5;  reasons.push({ kind:'money', txt: `$${(ourCents/100).toLocaleString()} quoted — low value`, pos:false }); }
    else                          { score -= 5;  reasons.push({ kind:'money', txt: 'Sub-$500 — minimal value', pos:false }); }
  } else {
    reasons.push({ kind:'money', txt: 'No $ on either side yet', pos:false });
  }

  // -------------------------------------------------------------------------
  // (2) STAGE CLOSENESS — how close to contract (up to +20)
  // -------------------------------------------------------------------------
  const stageScores = {
    terms_agreed_pending_client: 20,
    negotiating: 12,
    rate_sent: 6,
    awaiting_brand: 8,
  };
  const bump = stageScores[deal.raw_stage] || 0;
  score += bump;
  if (deal.raw_stage === 'terms_agreed_pending_client') {
    reasons.push({ kind:'stage', txt: 'Terms agreed — contract pending', pos:true });
  } else if (deal.raw_stage === 'negotiating') {
    reasons.push({ kind:'stage', txt: 'Active negotiation', pos:true });
  }

  // -------------------------------------------------------------------------
  // (3) BRAND RECENCY — how warm is the conversation (-20 to +10)
  // -------------------------------------------------------------------------
  if (daysQuiet === 0)      { score += 10; reasons.push({ kind:'pulse', txt: 'Brand active today — hot 🔥', pos:true }); }
  else if (daysQuiet <= 2)  { score += 5;  reasons.push({ kind:'pulse', txt: `Brand active ${daysQuiet}d ago`, pos:true }); }
  else if (daysQuiet <= 7)  { score -= 5;  reasons.push({ kind:'pulse', txt: `Brand quiet ${daysQuiet}d`, pos:false }); }
  else if (daysQuiet <= 14) { score -= 12; reasons.push({ kind:'pulse', txt: `Brand silent ${daysQuiet}d — cooling`, pos:false }); }
  else                      { score -= 20; reasons.push({ kind:'pulse', txt: `${daysQuiet}d silent — likely dead`, pos:false }); }

  // -------------------------------------------------------------------------
  // (4) EXCLUSIVITY CLASH — hard penalty if this deal conflicts with existing
  //     locked-in exclusivity windows from already-booked deals.
  // -------------------------------------------------------------------------
  const activeDeals = ctx.allActiveDeals || [];
  const cat = (deal.category || '').toLowerCase();
  const brandNorm = (deal.brand || '').toLowerCase();
  for (const other of activeDeals) {
    if (other.id === deal.id) continue;
    // Only confirmed/booked deals can lock exclusivity
    if (!['won','open'].includes(other.state)) continue;
    if (!['in_works','active'].includes(other.funnel_stage) && other.state !== 'won') continue;
    if (!other.exclusivity_required || !other.exclusivity_terms) continue;
    const terms = (other.exclusivity_terms || '').toLowerCase();
    // Match the brand name in the exclusivity terms (most precise)
    if (brandNorm && brandNorm.length >= 4 && terms.includes(brandNorm)) {
      score -= 50; blocked = true;
      reasons.push({ kind:'exclusivity', txt: `🚫 EXCLUSIVITY CLASH — ${other.brand} locked this brand`, pos:false, critical:true });
      break;
    }
    // Category-level lock (if exclusivity terms reference category, not just specific brands)
    if (cat && terms.includes(cat) && /(exclus|cannot.{0,15}promot|may not work with|no.{0,15}compet)/i.test(terms)) {
      score -= 25;
      reasons.push({ kind:'exclusivity', txt: `⚠ Category lock from ${other.brand} — may conflict`, pos:false });
    }
  }

  // -------------------------------------------------------------------------
  // (5) BURDEN — exclusivity ask + category concentration
  // -------------------------------------------------------------------------
  const exDays = deal.exclusivity_days || 0;
  if (exDays > 60)       { score -= 10; reasons.push({ kind:'burden', txt: `${exDays}d exclusivity ask — redline`, pos:false }); }
  else if (exDays > 30)  { score -= 4;  }
  // Category concentration — too many same-category deals = saturation risk
  const sameCat = activeDeals.filter(d => d.id !== deal.id && d.category && d.category === deal.category).length;
  if (sameCat > 4)       { score -= 8; reasons.push({ kind:'burden', txt: `${sameCat}+ active ${cat} deals — category-saturated`, pos:false }); }

  // -------------------------------------------------------------------------
  // Normalize + headline pick
  // -------------------------------------------------------------------------
  const tenScore = Math.max(1, Math.min(10, Math.round(score / 10)));
  // Headline = first positive reason, OR critical block, OR first negative
  const critical = reasons.find(r => r.critical);
  const positive = reasons.find(r => r.pos);
  const headline = (critical || positive || reasons[0])?.txt || '';

  return {
    score: tenScore,
    raw: score,
    headline,
    reasons: reasons.map(r => r.txt),
    blocked,
  };
}
