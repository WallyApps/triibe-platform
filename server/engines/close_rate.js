// close_rate.js — per-deal close probability estimator.
//
// Tiny dataset problem: Riley's historical terminal outcomes (won/lost) are in
// the single digits per raw_stage right now, so a naive per-stage average
// would be noisy and overfit. Solution: Bayesian blend.
//
//   p_close = (n_won + α·p_prior) / (n_total + α)
//
//   where p_prior is a hand-tuned playbook estimate per (raw_stage, ball,
//   days_quiet bucket) and α is a smoothing constant (default 10) that
//   controls how much evidence is needed before historical dominates.
//
// As Riley accumulates more terminal outcomes per bucket, the prior gets
// crowded out automatically. No code changes needed.

// Hand-tuned playbook priors. These mirror Riley's gut for "how likely is this
// stage actually closing?" Reviewable + tweakable as patterns shift.
const STAGE_PRIORS = {
  // High-confidence stages
  signed:                       0.98,
  contract_signed:              0.98,
  contract_received:            0.92,
  terms_agreed:                 0.78,
  terms_agreed_pending_client:  0.72,
  in_revision:                  0.90,
  in_production:                0.92,
  // Negotiation stages
  negotiating:                  0.45,
  rate_sent:                    0.35,
  // Early stages
  awaiting_brand:               0.28,
  discovery_call_scheduled:     0.40,
  mediakit_sent:                0.22,
  intro_sent:                   0.15,
  // Dead / near-dead
  dead:                         0.02,
  delivery_failed:              0.02,
  passed_budget:                0.05,
  on_hold:                      0.10,
  paused_by_brand:              0.08,
};
const DEFAULT_PRIOR = 0.20;

// Modifiers that shift the prior based on context.
const BALL_MOD = { brand: 0.92, them: 0.92, us: 1.05, riley: 1.05 };
function daysQuietMod(days) {
  if (days == null) return 1.0;
  if (days <= 2)  return 1.10;   // brand is warm, very close
  if (days <= 7)  return 1.00;
  if (days <= 14) return 0.85;
  if (days <= 30) return 0.65;
  return 0.40;                    // 30+ days quiet = mostly dead
}

const ALPHA_SMOOTHING = 10;       // ~10 historical samples needed to fully outweigh prior

/**
 * Fit empirical close rates from terminal-state deals (won + lost).
 * Returns a map of raw_stage → { n_won, n_total }.
 * Excludes dormant + open deals (still in flight).
 */
export async function fitHistoricalRates(db) {
  const rows = await db.prepare(`
    SELECT raw_stage, state, COUNT(*) AS n
    FROM deals
    WHERE state IN ('won','lost')
    GROUP BY raw_stage, state
  `).all();
  const table = {};
  for (const r of rows) {
    if (!table[r.raw_stage]) table[r.raw_stage] = { n_won: 0, n_total: 0 };
    if (r.state === 'won')   table[r.raw_stage].n_won   += r.n;
    table[r.raw_stage].n_total += r.n;
  }
  return table;
}

/**
 * Score a single deal's close probability.
 * Blends historical evidence with playbook prior using α-smoothing so small-
 * sample noise doesn't break the forecaster.
 *
 * @param {object} deal — must have raw_stage, ball_in_court, last_activity_at
 * @param {object} historicalRates — output of fitHistoricalRates()
 * @returns {object} { p_close, prior, evidence_n }
 */
export function scoreDeal(deal, historicalRates = {}) {
  const stage = deal.raw_stage || 'intro_sent';
  const prior = STAGE_PRIORS[stage] != null ? STAGE_PRIORS[stage] : DEFAULT_PRIOR;
  const hist  = historicalRates[stage] || { n_won: 0, n_total: 0 };

  // Bayesian blend
  let p = (hist.n_won + ALPHA_SMOOTHING * prior) / (hist.n_total + ALPHA_SMOOTHING);

  // Modifiers
  const ballKey = (deal.ball_in_court || '').toLowerCase();
  p *= (BALL_MOD[ballKey] || 1.0);

  const daysQuiet = deal.last_activity_at
    ? Math.floor((Date.now() - new Date(deal.last_activity_at).getTime()) / 86_400_000)
    : null;
  p *= daysQuietMod(daysQuiet);

  // Already-won / state=won deals are 1.0 by definition
  if (deal.state === 'won') p = 1.0;
  if (deal.state === 'lost' || /^(dead|delivery_failed|passed_budget)$/.test(stage)) p = 0.02;

  // Clamp
  p = Math.max(0.01, Math.min(0.99, p));
  return { p_close: p, prior, evidence_n: hist.n_total };
}

/**
 * Score a list of deals at once. Caller passes deals; we run fitHistoricalRates
 * once and reuse for every score.
 */
export async function scoreDeals(db, deals) {
  const rates = await fitHistoricalRates(db);
  return deals.map(d => ({ ...d, ...scoreDeal(d, rates) }));
}
