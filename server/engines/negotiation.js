// negotiation.js — extract OUR pitched rate vs BRAND offered rate from the
// actual conversation, then compute a "realistic close" fee that other engines
// (forecaster, close-score) can use instead of stale deal.fee_cents.
//
// Why this exists: deal.fee_cents is whatever Riley typed when creating the
// deal, which is often our first pitched number. But brands counter. The EV
// of "we asked $4.5K, they came back at $2K" is not $4.5K × p_close — it's
// somewhere between $2K and $4.5K × p_close. This parser walks the latest
// messages, extracts both sides' figures, and gives a realistic blended fee.

import { stripQuotedReply } from '../providers/inbound.gmail.js';

// Same range as the per-deal /negotiation endpoint — exclude bad matches like
// SKU numbers or year-stamps while catching real fee figures.
const FEE_MIN_CENTS = 30000;     // $300
const FEE_MAX_CENTS = 5000000;   // $50K

function highestDollar(text) {
  if (!text) return null;
  const matches = [...text.matchAll(/\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)(?!\d)/g)]
    .map(x => Math.round(parseFloat(x[1].replace(/,/g, '')) * 100))
    .filter(c => c >= FEE_MIN_CENTS && c <= FEE_MAX_CENTS);
  return matches.length ? Math.max(...matches) : null;
}

function cleanMsg(m) {
  if (!m) return '';
  let b = m.body || m.snippet || '';
  if (m.channel === 'email' && b) {
    try { b = stripQuotedReply(b) || b; } catch {}
  }
  return b;
}

/**
 * Parse OUR pitched rate + BRAND counter from the latest two messages on the
 * deal's thread. Returns { our_quote_cents, brand_counter_cents, brand_accepted,
 * realistic_fee_cents }.
 *
 * realistic_fee_cents picks the most honest number for EV math:
 *   • brand accepted → ourCents (we'll close at our ask)
 *   • brand counter < ours → midpoint (we'll meet them somewhere)
 *   • brand counter > ours → ourCents (cap to our ask; we won't get more than what we asked)
 *   • no brand $ yet → ourCents (or deal.fee_cents)
 *   • nothing at all → null (deal has no priced expectation)
 */
export function parseNegotiation(db, deal) {
  const lb = db.prepare(`
    SELECT m.body, m.snippet, m.sent_at, m.channel
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE t.deal_id = ? AND m.from_us = 0
    ORDER BY m.sent_at DESC LIMIT 1`).get(deal.id);
  const lo = db.prepare(`
    SELECT m.body, m.snippet, m.sent_at, m.channel
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE t.deal_id = ? AND m.from_us = 1
    ORDER BY m.sent_at DESC LIMIT 1`).get(deal.id);

  const lbClean = cleanMsg(lb);
  const loClean = cleanMsg(lo);
  const detectedOurs   = highestDollar(loClean);
  const detectedBrand  = highestDollar(lbClean);

  const ourCents   = deal.fee_cents || detectedOurs || null;
  let counterCents = null;
  let accepted     = false;

  if (detectedBrand && ourCents) {
    const diff = Math.abs(detectedBrand - ourCents) / ourCents;
    if (diff <= 0.01) accepted = true;
    else counterCents = detectedBrand;
  } else if (detectedBrand && !ourCents) {
    counterCents = detectedBrand;
  }

  // No middle-ground guessing anymore. Riley wants to see what the brand
  // actually said vs what he actually said — not a midpoint that pretends a
  // deal will land somewhere neither side has committed to. The UI surfaces
  // both numbers separately when they differ; for EV math we anchor on OUR
  // quote (the rate we're holding firm at), which lets p_close handle the
  // "will brand actually pay our number" question.
  let realistic = null;
  if (accepted)                                       realistic = ourCents;
  else if (ourCents != null)                          realistic = ourCents;
  else if (counterCents != null)                      realistic = counterCents;

  return {
    our_quote_cents: ourCents,
    brand_counter_cents: counterCents,
    brand_accepted: accepted,
    realistic_fee_cents: realistic,
  };
}
