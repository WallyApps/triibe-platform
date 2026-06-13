// lifecycle_audit.js — AI-powered re-audit of a deal's full conversation.
//
// Takes the deal + every Gmail/WA message that exists for it and asks GPT to
// classify which lifecycle steps are done / active / waiting / todo based on
// what the conversation actually shows. Replaces the keyword-based inference
// in lifecycle.js with a real understanding of the thread.
//
// Returns a verdict object:
//   {
//     terms_agreed:     { status: 'done',    evidence: '...', confidence: 0.95 },
//     contract_signed:  { status: 'done',    evidence: '...', confidence: 0.92 },
//     cook_script:      { status: 'done',    evidence: 'Riley sent script PDF Jun 10', confidence: 0.88 },
//     send_script:      { status: 'done',    evidence: 'Same email', confidence: 0.88 },
//     await_script_approval: { status: 'active', evidence: 'Silvija replied Jun 11 with edits', confidence: 0.91 },
//     ...
//   }
//
// Status enum: 'done' | 'active' | 'waiting' | 'todo' | 'skipped' | 'unknown'
//
// Triggered by:
//   - New message ingest (debounced 30s per deal to avoid burst re-audits)
//   - posting_date passing
//   - explicit /api/deal/:id/audit POST

import { stripQuotedReply } from '../providers/inbound.gmail.js';
import { promoteFromAuditVerdict } from './auto_promote.js';

// Step kinds to audit — matches what lifecycle.js generates. Keep the list
// short + stable so the AI prompt stays cheap.
const STEP_KINDS = [
  { kind: 'terms_agreed',           label: 'Terms agreed on fee + scope' },
  { kind: 'contract_signed',        label: 'Contract / agreement signed by both sides' },
  { kind: 'cook_script',            label: 'Script or concept drafted' },
  { kind: 'send_script',            label: 'Script sent to brand for review' },
  { kind: 'await_script_approval',  label: 'Brand approved (or requested edits on) the script' },
  { kind: 'film_edit',              label: 'Video filmed + edited' },
  { kind: 'send_draft',             label: 'Draft video sent to brand for approval' },
  { kind: 'await_draft_approval',   label: 'Brand approved (or requested edits on) the draft' },
  { kind: 'post_live',              label: 'Content posted live on the platform' },
  { kind: 'analytics',              label: 'Analytics / performance screenshots sent to brand' },
  { kind: 'send_invoice',           label: 'Invoice issued for the agreed fee' },
  { kind: 'await_payment',          label: 'Payment received' },
];

const SYSTEM_PROMPT = `You are auditing the lifecycle status of a brand partnership deal based on the actual email + WhatsApp conversation between the talent manager (Riley Wallack) and the brand.

You will be given:
1. Deal context (brand, creator, fee, posting date, current funnel stage)
2. Full chronological message history (email + WhatsApp)

Your job: for each of the lifecycle steps listed, classify its status based ONLY on what the conversation shows.

STATUSES:
- "done": there is clear evidence in the conversation this step is complete (e.g. "I sent the script", brand says "approved", payment confirmation)
- "active": this step is what's CURRENTLY happening or what Riley needs to act on right now
- "waiting": Riley has done his part and is waiting for brand to respond
- "todo": not started yet, future step
- "skipped": doesn't apply to this deal type (e.g. raw-footage deal with no posting step)

RULES:
- Be conservative. If unclear, prefer "todo" or "unknown" over "done".
- Evidence must reference a specific message or fact. No speculation.
- CROSS-REFERENCE the brand thread WITH the internal creator chat. The creator
  telling Riley "Sintra signed" / "filming today" / "draft is up" / "got paid"
  IS authoritative — mark the matching step "done" even if the brand thread
  doesn't mention it. Cite the creator message in evidence ("Cooper confirmed signed Jun 9").
- "Contract signed" is done if either side confirms execution OR the creator
  says they signed it.
- "Cook script" is done if Riley has sent ANY script-related document/link/text to the brand
- "Send script" is done when the script is in the brand's hands
- "Await script approval" is "active" if brand replied with edits/feedback, "waiting" if brand hasn't replied, "done" if brand clearly approved
- "Film + edit" is done if the creator says they filmed/edited OR a draft was sent
- "Post live" is "done" if posting_date is past AND there's any "posted" / "live" / "going up" confirmation (from brand OR creator)
- "Send invoice" is "done" if there's a payment_in_flight signal OR invoice was attached
- "Await payment" is "done" if there's a Lumanu/Wise/Payoneer/etc. transfer message OR the creator confirms they were paid

Return ONLY a JSON object with this exact shape, no commentary:
{
  "step_kind": { "status": "done|active|waiting|todo|skipped|unknown", "evidence": "1-line citation", "confidence": 0.0-1.0 },
  ...
}`;

/**
 * Run an AI audit on a single deal.
 *
 * @param {object} opts
 * @param {object} opts.db - DB handle
 * @param {object} opts.deal - the deal row
 * @param {string} opts.apiKey - OpenAI API key
 * @param {object} opts.spend - SpendGuard instance for cost gating
 * @returns {Promise<object|null>} verdict object or null on failure
 */
export async function auditDealLifecycle({ db, deal, apiKey, spend }) {
  if (!deal || !deal.id) return null;
  if (!apiKey) return null;

  // Spend gate — keep this cheap, dedupe per-deal so a burst of inbound msgs
  // doesn't trigger 10 audits in 30 seconds.
  const dedupe_key = `lifecycle_audit:${deal.id}:${Date.now() / 30_000 | 0}`;
  const gate = spend?.attempt?.({ dedupe_key });
  if (gate && !gate.ok) return null;

  // Pull full conversation for this deal (all threads, all channels)
  const rows = await db.prepare(`
    SELECT m.sent_at, m.channel, m.sender, m.from_us, m.body, m.snippet
    FROM messages m
    JOIN threads t ON t.id = m.thread_id
    WHERE t.deal_id = ?
    ORDER BY m.sent_at ASC
  `).all(deal.id);

  // ALSO pull the internal creator chat (COOPER X TRIIBE / CHARLIE X TRIIBE).
  // These messages aren't linked to a deal_id but often carry the real status
  // signal — "Sintra signed, filming today" / "draft going to brand tonight" /
  // "got the wire from Lumanu" — that the brand thread alone never shows.
  // Match by brand name keywords (case-insensitive) so we only inject messages
  // actually about THIS deal, not the creator's whole chat history.
  let creatorRows = [];
  if (deal.creator_id) {
    const chatLike = `%${deal.creator_id.toUpperCase()} X TRIIBE%`;
    const brand = (deal.brand || '').toLowerCase();
    // Build keyword set from brand name: split on " — ", "/", "(", and whitespace
    // tokens of len>=4. Filters generic words so we don't false-match.
    const STOP = new Set(['the','and','agent','ai','co','app','inc','tiktok','youtube','reel','via','team','direct','com']);
    const tokens = [...new Set(brand
      .split(/[\s/()\-—–,.]+/)
      .map(t => t.trim())
      .filter(t => t.length >= 4 && !STOP.has(t)))];
    if (tokens.length) {
      const sinceDays = 45;  // creator confirmations stay relevant ~6wk
      const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
      const likeClauses = tokens.map(() => '(LOWER(m.body) LIKE ? OR LOWER(m.snippet) LIKE ?)').join(' OR ');
      const likeArgs = tokens.flatMap(t => [`%${t}%`, `%${t}%`]);
      creatorRows = await db.prepare(`
        SELECT m.sent_at, m.channel, m.sender, m.from_us, m.body, m.snippet
        FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE t.channel = 'whatsapp' AND t.subject LIKE ?
          AND m.sent_at > ?
          AND (${likeClauses})
        ORDER BY m.sent_at ASC LIMIT 20
      `).all(chatLike, since, ...likeArgs);
    }
  }

  // Build a compact transcript — strip quoted reply chains, cap each msg
  const formatRow = (r, scope) => {
    let body = r.body || r.snippet || '';
    if (r.channel === 'email' && body) {
      try { body = stripQuotedReply(body) || body; } catch {}
    }
    body = body.replace(/\s+/g, ' ').trim().slice(0, 600);
    let sender;
    if (scope === 'creator') {
      sender = r.from_us ? 'Riley → creator' : `${(deal.creator_id||'creator')[0].toUpperCase()}${(deal.creator_id||'creator').slice(1)}`;
    } else {
      sender = r.from_us ? 'Riley (us)' : (r.sender ? r.sender.split('<')[0].trim().slice(0, 35) : 'brand');
    }
    const when = (r.sent_at || '').slice(0, 16).replace('T', ' ');
    const ch = scope === 'creator' ? '[INTERNAL]' : (r.channel === 'whatsapp' ? '[WA]' : '[email]');
    return `${ch} ${when} ${sender}: ${body}`;
  };
  const brandTranscript = rows.map(r => formatRow(r, 'brand')).join('\n');
  const creatorTranscript = creatorRows.map(r => formatRow(r, 'creator')).join('\n');

  // If there's literally nothing to audit, return early
  if (!brandTranscript.trim() && !creatorTranscript.trim()) return null;

  const dealContext = [
    `Brand: ${deal.brand}`,
    `Creator: ${deal.creator_id}`,
    `Fee: ${deal.fee_cents ? '$' + (deal.fee_cents/100).toLocaleString() : 'not set'}`,
    `Posting date: ${deal.posting_date || 'not set'}`,
    `Funnel stage: ${deal.funnel_stage} (raw: ${deal.raw_stage || ''})`,
    `State: ${deal.state}`,
  ].join('\n');

  const stepList = STEP_KINDS.map(s => `- ${s.kind}: ${s.label}`).join('\n');

  const userPrompt = `DEAL CONTEXT:
${dealContext}

LIFECYCLE STEPS TO AUDIT:
${stepList}

BRAND CONVERSATION (oldest first):
${brandTranscript.slice(0, 9000) || '(no brand-thread messages on file)'}

INTERNAL CHAT WITH ${(deal.creator_id || 'creator').toUpperCase()} — messages mentioning this brand (oldest first).
TREAT THESE AS GROUND TRUTH for delivery/signing/payment status. If the creator confirms "Sintra signed" or "wire came in", the corresponding step is DONE even if the brand thread hasn't caught up:
${creatorTranscript.slice(0, 3000) || '(no internal creator messages about this brand)'}

Return the verdict JSON now.`;

  // Make the API call. Using gpt-4o-mini for cost. JSON mode forces valid output.
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 1500,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    console.warn(`[lifecycle_audit] ${deal.id} api err:`, e.message);
    return null;
  }

  if (!response.ok) {
    const txt = await response.text().catch(()=>'');
    console.warn(`[lifecycle_audit] ${deal.id} status ${response.status}:`, txt.slice(0, 200));
    return null;
  }

  const data = await response.json();
  const usage = data.usage || {};
  // gpt-4o-mini pricing: $0.15/M input, $0.60/M output (rough)
  const est_cost_cents = Math.ceil(
    ((usage.prompt_tokens || 0) * 0.000015 + (usage.completion_tokens || 0) * 0.00006) * 100
  );
  spend?.charge?.({
    dedupe_key,
    purpose: 'lifecycle_audit',
    deal_id: deal.id,
    prompt_tokens: usage.prompt_tokens || 0,
    completion_tokens: usage.completion_tokens || 0,
    est_cost_cents,
  });

  let verdict;
  try {
    verdict = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  } catch (e) {
    console.warn(`[lifecycle_audit] ${deal.id} bad JSON:`, e.message);
    return null;
  }

  // Sanity check: ensure every key matches a known step + clamp confidence
  const cleaned = {};
  for (const [k, v] of Object.entries(verdict)) {
    if (!STEP_KINDS.find(s => s.kind === k)) continue;
    if (!v || typeof v !== 'object') continue;
    const status = String(v.status || 'unknown');
    if (!['done','active','waiting','todo','skipped','unknown'].includes(status)) continue;
    cleaned[k] = {
      status,
      evidence: String(v.evidence || '').slice(0, 240),
      confidence: Math.max(0, Math.min(1, Number(v.confidence) || 0)),
    };
  }

  applyImplications(cleaned, deal);

  // Persist to deal record
  try {
    await db.prepare(`UPDATE deals SET lifecycle_state = ?, lifecycle_audited_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(cleaned), deal.id);
  } catch (e) {
    console.warn(`[lifecycle_audit] ${deal.id} persist err:`, e.message);
  }

  // Auto-promote the deal's funnel state if the audit found high-confidence
  // signals the row hasn't caught up to yet. Right now: contract_signed=done
  // bumps raw_stage to signed (state=won). Logs an Undo-able notification so
  // Riley can roll back if the AI got it wrong.
  try {
    const r = await promoteFromAuditVerdict({ db, deal, verdict: cleaned });
    if (r.promoted) {
      console.log(`[lifecycle_audit] ${deal.id} auto-promoted: ${r.applied.new_raw_stage}`);
    }
  } catch (e) {
    console.warn(`[lifecycle_audit] ${deal.id} promote err:`, e.message);
  }

  return cleaned;
}

// ---- Monotonic implications -------------------------------------------------
// The AI sometimes contradicts itself — e.g. marks await_draft_approval as
// "waiting" (brand is reviewing) but leaves send_draft as "todo". A later step
// being in-flight implies all earlier "produce output" steps are done. Also,
// a deal's persisted state (state=won) is ground truth that overrides any
// looser AI reading of the thread.
const STEP_ORDER = [
  'terms_agreed','contract_signed','cook_script','send_script','await_script_approval',
  'film_edit','send_draft','await_draft_approval','post_live','analytics',
  'send_invoice','await_payment',
];
const IN_FLIGHT = new Set(['done','active','waiting']);

function applyImplications(v, deal) {
  if (!v || typeof v !== 'object') return;

  // Ground truth from deal record
  if (deal?.state === 'won') {
    if (v.terms_agreed)    { v.terms_agreed.status    = 'done'; }
    if (v.contract_signed) { v.contract_signed.status = 'done'; }
  }

  // Forward implication: if step N is in-flight, every prior non-skipped step
  // is done. Walk back-to-front.
  for (let i = STEP_ORDER.length - 1; i >= 0; i--) {
    const k = STEP_ORDER[i];
    if (!v[k] || !IN_FLIGHT.has(v[k].status)) continue;
    for (let j = 0; j < i; j++) {
      const prior = v[STEP_ORDER[j]];
      if (!prior || prior.status === 'skipped' || prior.status === 'done') continue;
      prior.status = 'done';
      if (!prior.evidence) prior.evidence = `implied by ${k}`;
    }
    break; // walking back-to-front, first in-flight step is the watermark
  }
}

// ---- Debounced trigger ------------------------------------------------------
// Queue audits keyed by deal_id. A burst of inbound messages for the same deal
// = one audit ~30s after the last message lands.
const _pending = new Map();  // deal_id -> { db, deal, apiKey, spend, fireAt }
const DEBOUNCE_MS = 30_000;

export function queueAudit({ db, deal, apiKey, spend }) {
  if (!deal || !deal.id || !apiKey) return;
  const now = Date.now();
  const fireAt = now + DEBOUNCE_MS;
  _pending.set(deal.id, { db, deal, apiKey, spend, fireAt });
}

// Run every 10s — pick up any audits whose debounce window has elapsed
setInterval(async () => {
  const now = Date.now();
  for (const [deal_id, payload] of [..._pending.entries()]) {
    if (payload.fireAt > now) continue;
    _pending.delete(deal_id);
    try {
      await auditDealLifecycle(payload);
    } catch (e) {
      console.warn(`[lifecycle_audit] queued audit ${deal_id} err:`, e.message);
    }
  }
}, 10_000);

export { STEP_KINDS };
