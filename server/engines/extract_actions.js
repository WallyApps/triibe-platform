// extract_actions.js — read the actual thread context for a deal and extract
// concrete, real-world action items with the dates the BRAND actually said,
// not heuristic guesses. Always trust thread context over contract terms
// (Riley's rule: "contracts can be placeholders, emails are ground truth").
//
// Cached per-deal in deal_actions_cache, keyed by deal.last_activity_at so
// it only regenerates when the thread moves.

import { createHash } from 'node:crypto';

function hash(s) { return createHash('sha1').update(String(s)).digest('hex').slice(0, 16); }

/**
 * Build the AI extractor for a single deal.
 * Returns { actions: [...], regenerated: true|false }
 */
export async function extractActionsForDeal({ db, deal, apiKey, stripQuotedReply }) {
  if (!apiKey) return { actions: null, regenerated: false };
  // Compute cache key — regenerate only when activity changes or obligations change
  let obligations = [];
  try { obligations = JSON.parse(deal.obligations || '[]'); } catch {}
  const PROMPT_VERSION = 'v3';  // bump to bust cache when prompt changes
  const cacheKey = hash([
    PROMPT_VERSION,
    deal.last_activity_at || '',
    deal.raw_stage || '',
    deal.state || '',
    deal.posting_date || '',
    deal.fee_cents || '',
    JSON.stringify(obligations),
  ].join('|'));

  const cached = db.prepare(`SELECT actions_json, cache_key FROM deal_actions_cache WHERE deal_id=?`).get(deal.id);
  if (cached && cached.cache_key === cacheKey) {
    try {
      const parsed = JSON.parse(cached.actions_json);
      // Backward compat: if cache is just an array (old format), wrap it
      if (Array.isArray(parsed)) return { actions: parsed, key_dates: {}, regenerated: false };
      return { actions: parsed.actions || [], key_dates: parsed.key_dates || {}, regenerated: false };
    } catch {}
  }

  // Pull last 15 messages from the deal's threads, oldest → newest
  const msgs = db.prepare(`
    SELECT m.from_us, m.sent_at, m.body, m.snippet, m.channel, m.sender
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE t.deal_id = ?
    ORDER BY m.sent_at DESC LIMIT 15`).all(deal.id).reverse();

  if (!msgs.length && !obligations.length) {
    // Nothing to read — return null, caller will use heuristic fallback
    return { actions: null, regenerated: false };
  }

  const threadText = msgs.map(m => {
    let body = m.body || m.snippet || '';
    if (m.channel === 'email' && body && stripQuotedReply) {
      try { body = stripQuotedReply(body) || body; } catch {}
    }
    body = body.replace(/\s+/g, ' ').trim().slice(0, 600);
    const who = m.from_us ? 'Riley' : (m.sender ? m.sender.split('<')[0].trim().slice(0,30) : 'brand');
    return `[${(m.sent_at || '').slice(0,10)} ${m.channel}] ${who}: ${body}`;
  }).join('\n');

  const obList = obligations.length
    ? obligations.map(o => `- ${o.type}: ${o.what}${o.when ? ' by ' + o.when : ''}${o.required ? ' (REQUIRED)' : ''}`).join('\n')
    : '(no contract obligations on file)';

  const sys = `You read the actual brand-Riley conversation thread for a deal and return ONLY the concrete actions Riley needs to take RIGHT NOW, with REAL DATES extracted from what the brand actually said.

CRITICAL RULES:
- TRUST THE THREAD OVER THE CONTRACT. If brand emails say "send script by Jun 13-14" but contract says "Jun 16", use the email date.
- DON'T INVENT ACTIONS. If thread doesn't establish an action, don't include it.
- SKIP ACTIONS THAT ARE ALREADY DONE. If Riley said "script sent on Jun 5" → don't include "deliver script".
- SKIP CONTINGENT/BACKUP DEALS. If deal is "backup", "demoted", "pending confirmation", "brand silent for X days without acceptance" → return empty actions, the deal isn't real yet.
- SKIP DEALS WHERE THE RATE ISN'T ACCEPTED YET. raw_stage = rate_sent, negotiating, terms_agreed_pending_client → don't surface delivery actions because nothing is locked.
- PASS-THROUGH DATES: if the thread mentions an explicit date (Jun 13, June 20, 6/20, next Friday, etc.), put the literal date in the action.

DIRECTION OF MONEY/INVOICES (don't get confused):
- Riley sends invoices FROM Triibe Talents TO the brand. Never "invoice to Triibe".
- Brands PAY Triibe. Riley does not pay brands.
- Default invoice direction: "Issue invoice TO [brand]".

TIER GUIDANCE:
- "red" = overdue OR due within 2 days (genuinely urgent)
- "amber" = due this week (3-7 days out)
- "green" = due next week or later, OR no firm date (just a soft follow-up)
- A "polite check-in" / "follow up" with no specific deadline → "amber" (not "red"). Don't manufacture urgency.

PROMPT-VERSION: v2

ACTION TYPES (return one of these for "kind"):
  "sign_contract" — Riley needs to countersign or have creator sign
  "deliver_asset" — Send script/video/concept to brand
  "post" — Creator posts on social
  "send_invoice" — Issue invoice to brand
  "chase_payment" — Payment overdue, chase
  "confirm_scope" — Lock deliverables/timeline with brand
  "nudge" — Brand quiet, send polite check-in
  "respond_to_brand" — Brand asked a specific question
  "internal_creator_ask" — Riley needs to ask creator something
  "other" — Anything else (give a descriptive label)

OUTPUT (JSON only):
{
  "actions": [
    {
      "kind": "...",
      "label": "Short action sentence (e.g. 'Sign DocuSign contract')",
      "detail": "1-line context (e.g. 'Silvija sent it 3d ago, waiting on Cooper')",
      "date_label": "Real date OR phrase from thread (e.g. 'by Jun 13-14', 'tomorrow', 'overdue 2d', 'no firm date')",
      "tier": "red" | "amber" | "green",  // red=overdue or due in 0-2d, amber=this week, green=later
      "evidence": "the exact quote or message that grounds this action"
    }
  ],
  "key_dates": {
    // Pull these from the THREAD text (brand emails). Use the EXACT date the brand mentioned, in YYYY-MM-DD when possible, or leave the literal phrase.
    "post":         "YYYY-MM-DD" or phrase like "Jun 20" or null,
    "script_due":   "YYYY-MM-DD" or phrase like "Jun 13-14" or null,
    "delivery":     "YYYY-MM-DD" or null (raw footage delivery if separate from posting),
    "payment_due":  "YYYY-MM-DD" or phrase like "Jul 5 (net 30)" or null,
    "sign_by":      "YYYY-MM-DD" or null (contract signature deadline)
  }
}
- Output 0-5 actions per deal. Quality > quantity. If nothing actionable, return {"actions":[]}.
- key_dates should always be present even if some values are null.`;

  const user = `DEAL: ${deal.brand}
STAGE: ${deal.funnel_stage} / ${deal.raw_stage}, state=${deal.state}
FEE: ${deal.fee_cents ? '$' + (deal.fee_cents/100).toLocaleString() : 'TBD'}
POSTING DATE ON FILE: ${deal.posting_date || '(none)'}
RILEY'S NOTE: ${(deal.next_action_detail || '').slice(0, 400)}

CONTRACT OBLIGATIONS (placeholder — TRUST THREAD MORE):
${obList}

RECENT THREAD (oldest → newest):
${threadText || '(no thread messages on file)'}

Extract Riley's real actions for this deal.`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST', headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.1,
        max_tokens: 800,
        response_format: { type: 'json_object' },
        messages: [{role:'system',content:sys},{role:'user',content:user}],
      }),
    });
    if (!r.ok) return { actions: null, regenerated: false };
    const data = await r.json();
    let parsed = {};
    try { parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}'); } catch {}
    const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
    const key_dates = parsed.key_dates && typeof parsed.key_dates === 'object' ? parsed.key_dates : {};
    // Persist as JSON envelope so we can carry key_dates too
    const envelope = { actions, key_dates };
    db.prepare(`INSERT OR REPLACE INTO deal_actions_cache (deal_id, actions_json, cache_key, generated_at)
      VALUES (?, ?, ?, datetime('now'))`).run(deal.id, JSON.stringify(envelope), cacheKey);
    return { actions, key_dates, regenerated: true };
  } catch (e) {
    return { actions: null, regenerated: false };
  }
}
