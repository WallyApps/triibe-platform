// classify_message.js — tag every brand inbound with action_type + authority.
// Cached per message in messages.classification (JSON column).
//
// The goal: stop treating soft brand requests (e.g. "could you publish your
// Helper to the marketplace?") the same as contract obligations (e.g.
// "post by June 20"). Authority drives play urgency downstream.

/**
 * Classify a brand message in the context of its deal.
 * @returns { action_type, authority, requires_response, deadline_hint, reason } or null
 */
// Out-of-office auto-reply detection — short-circuit BEFORE the AI call so we
// (a) don't burn tokens classifying noise, and (b) downstream engines (auto-park,
// inbox, close-score) can treat OOO as "no real engagement." Riley's rule: if a
// brand only ever sent an OOO, they're still ghosting the pitch.
//
// Heuristic — match common patterns. Bias toward FALSE POSITIVES being rare
// (a real brand reply that mentions "out of office" in context will get sent
// to the AI anyway via the broader classification flow).
function detectOOO(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  // High-confidence patterns — almost always indicates an auto-reply
  const strong = [
    /out\s+of\s+(the\s+)?office/i,
    /\bautomat(ic|ed)\s+reply\b/i,
    /\bauto[-\s]?reply\b/i,
    /(currently|am)\s+away\s+from\s+(the\s+)?(office|desk)/i,
    /i'?m\s+(currently\s+)?(on\s+(vacation|holiday|leave|pto)|out\s+of\s+the\s+country)/i,
    /thank you for your (email|message)[\s\S]{0,80}(?:back|return|reach)/i,
    /will\s+(return|be\s+back)\s+(to\s+(the\s+)?office\s+)?on\s+\w/i,
    /limited\s+access\s+to\s+(my\s+)?email/i,
    /maternity\s+leave|parental\s+leave/i,
  ];
  if (strong.some(rx => rx.test(t))) return true;
  // Weaker signal — needs two of these to qualify
  const weak = [/away from/i, /\bback on\b/i, /\breach (?:out )?(?:to )?\S+@/i, /please contact/i, /for urgent/i, /\bin my absence\b/i];
  const weakHits = weak.filter(rx => rx.test(t)).length;
  return weakHits >= 2 && t.length < 1500;  // short auto-reply length
}

export async function classifyMessage({ apiKey, message, deal, obligations }) {
  if (!apiKey) return null;
  if (!message?.body && !message?.snippet) return null;

  const text = (message.body || message.snippet || '').slice(0, 4000);

  // Pre-AI shortcut for OOO replies — no token spend, instant classification,
  // and a clear marker for auto-park + inbox so OOO doesn't fake brand engagement.
  if (detectOOO(text)) {
    return {
      action_type: 'ooo',
      authority: 'fyi',
      requires_response: false,
      deadline_hint: null,
      reason: 'Out-of-office auto-reply — not real brand engagement.',
    };
  }
  const obList = (obligations || []).map(o =>
    `- ${o.type}: ${o.what}${o.when ? ' by ' + o.when : ''}${o.required ? ' (REQUIRED)' : ''}`
  ).join('\n') || '(no obligations on file)';

  const sys = `You read a brand's email/message to an influencer manager (Riley) and classify it.

Return ONLY JSON:
{
  "action_type": one of:
    "response_required"   — brand asks a question or needs a yes/no answer
    "review_required"     — brand sent something needing Riley's review (brief, contract, asset)
    "soft_request"        — brand asks for something not in the contract (e.g. publish helper, share metrics, attend event)
    "fyi"                 — informational update, no action needed (e.g. "we'll get back to you", "thanks for the script")
    "payment_chase"       — payment-related (asking for invoice, banking info, etc.)
    "reminder"            — brand pinging about something Riley already owes
    "negotiation_move"    — brand making a counter, concession, or new term proposal,
  "authority": one of:
    "contract_obligation" — references something the creator IS contractually required to do
    "negotiated_term"     — references something agreed in thread but not yet in signed contract
    "soft_request"        — brand is asking for something NOT in the contract (nice-to-have)
    "fyi"                 — no authority, just info,
  "requires_response": true/false (does Riley personally need to reply?),
  "deadline_hint": string or null (e.g. "before launch tomorrow", "EOD Friday", "next week"),
  "reason": one short sentence why you classified it this way
}

CRITICAL RULES:
- Compare the brand's ask against the CREATOR'S CONTRACTUAL OBLIGATIONS below.
- If the brand asks for something IN the obligations list → authority = "contract_obligation"
- If the brand asks for something NOT in obligations → authority = "soft_request" (even if they say "please" politely)
- A polite request to "please publish your Helper" without a contract clause requiring it = soft_request
- "Thanks for the update, we'll get back to you" = fyi
- A counter at a new price = negotiation_move + contract_obligation tier (this IS the deal)
- A request to "send banking info" = payment_chase + contract_obligation (you need to be paid)`;

  const user = `BRAND: ${deal?.brand || 'unknown'}
DEAL STAGE: ${deal?.funnel_stage || '?'} / ${deal?.raw_stage || '?'}
DEAL FEE: ${deal?.fee_cents ? '$' + (deal.fee_cents/100).toLocaleString() : 'TBD'}

CREATOR'S CONTRACTUAL OBLIGATIONS (per signed contract — these are the ONLY things contractually owed):
${obList}

BRAND'S MESSAGE:
${text}

Classify it.`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST', headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.1,
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [{role:'system',content:sys},{role:'user',content:user}],
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return JSON.parse(data.choices?.[0]?.message?.content || '{}');
  } catch (e) {
    return null;
  }
}
