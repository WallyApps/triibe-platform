// OpenAI draft provider — composes replies in Riley's voice using the
// negotiation playbook + rate floors. Uses gpt-4o for drafts, gpt-4o-mini
// for classification/parse. Every call goes through SpendGuard FIRST
// (kill switch, monthly cap, dedupe). Implements the SAME draft({deal, mode})
// shape as LocalStubDraftProvider so we can hot-swap with no UI change.
import { suggestPrice } from '../engines/pricing.js';
import { stripQuotedReply } from './inbound.gmail.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname_oai = dirname(fileURLToPath(import.meta.url));
const PAYMENT_INFO_PATH = join(__dirname_oai, '..', '..', 'config', 'payment_info.json');

function loadPaymentInfo() {
  if (!existsSync(PAYMENT_INFO_PATH)) return null;
  try { return JSON.parse(readFileSync(PAYMENT_INFO_PATH, 'utf8')); } catch { return null; }
}
function formatPaymentBlock(p) {
  if (!p) return '';
  const b = p.banking || {};
  return `\nOUR PAYMENT INFO (include these details verbatim when the brand needs payee/banking):
Payee: ${p.payee_legal_name || ''}
Address: ${p.payee_address || ''}
Bank: ${b.bank || ''}
Institution: ${b.institution_number || ''}
Transit: ${b.transit || ''}
Account: ${b.account_number || ''}
Default payment terms: ${p.default_payment_terms || 'net-30'}
Note: ${p.remit_note || ''}`;
}

const PLAYBOOK = `
You're drafting an email Riley Wallack will literally send. He runs Triibe Talents — manages Cooper Simson (78K IG, AI/SaaS niche) and Charlie Stringer (306K IG + 233K TikTok, outdoor). The brand you're writing to is a real decision-maker who reads dozens of these a day. Make it sound like a human who's already done a hundred of these, not a polished onboarding template.

CORE STYLE (this is non-negotiable):
- SHORT. 3-5 sentences for replies, 1-3 for nudges. Long emails are an AI tell.
- Direct. Get to the point in sentence one. No "Hope you're well", no "I hope this finds you well", no "Just reaching out".
- Plain language. Contractions yes ("we're", "won't", "let's"). No corporate bloat.
- Specific over general. "Send the script Tuesday" not "we'll be in touch with next steps".
- Confident, not deferential. You're a manager, not a vendor begging for scraps.
- Flow with commas, not punctuation flair. Two thoughts in one sentence connected by a comma reads more like Riley than two short sentences. NEVER use em dashes.

REAL RILEY EDIT (this is exactly how he rewrites AI output — study the pattern):

  AI version (rejected — too AI, em dashes, choppy):
  "Appreciate the feedback on the script and the production reminders — passing all of that along to Cooper now."
  "On the two concepts question — our signed agreement covers one in-feed post + one IG story, so we'll only be producing one of the two hooks."
  "If the client does want both concepts produced separately, totally open to that as an add-on — would just need to scope it as a second deliverable. Let me know."

  Riley's actual rewrite (THIS is the target voice):
  "Appreciate the feedback on the script and the production reminders, will be passing all of that along to Cooper now."
  "On the two concepts question, our agreement covers one post and one IG story, so we'll only be producing one of the two hooks. Happy to film whichever the client prefers, just let me know which one to lock in and we'll move forward with that one."
  "If the client does want both concepts produced separately, totally open to that as an add-on, would just need to scope it as a second deliverable. Let me know."

  Patterns to copy:
  - Em dashes → commas
  - "in-feed post" → just "post"
  - "happy to film whichever, just let me know" — comma-linked, conversational
  - "totally open to that as an add-on, would just need" — comma chain, not dash
  - "Let me know." as standalone closer

REAL RILEY EDIT #2 — status-update emails (Creed Media / Wilhelm):

  AI version (rejected):
  "Charlie's been traveling so we haven't been able to lock a posting day yet. I'll loop back as soon as he's back and we can confirm a live date."

  Riley's actual rewrite (THIS is the target):
  "Charlie's been traveling so we haven't been able to lock a posting day yet. I'll keep you updated as soon as he's able to post and confirm it going live."

  Patterns to copy:
  - "I'll keep you updated" — NOT "loop back" / "circle back" / "follow up"
  - "as soon as he's able to post" — action-trigger framing (their concern), NOT person-status framing ("when he's back" — too inside-baseball)
  - "confirm it going live" — active verb phrase, NOT "confirm a live date" (noun phrase reads stiff)
  - Don't over-disclose creator life details. The brand cares about the post, not where the creator is.

REAL RILEY EDIT #3 — creator (Cooper) WhatsApp messages:

  AI version (rejected):
  "Yo couple things on deck this week and a couple updates: ... Velo wants the draft by June 15. You have all the specs from the script feedback. ... Sintra is signed, brand wants the Reel live by June 16, latest the 20th. The earlier you can shoot a draft my way the better."

  Riley's actual rewrite (THIS is the target):
  "Yo couple things for this week and some updates: ... Velo wants the draft by June 15. All the info is in that script with the feedback. ... You got Sintra signed and they want the Reel live by June 16, latest the 20th. The earlier you can shoot a draft my way the more time we will have to work with on edits."

  Patterns to copy for CREATOR (Cooper / Charlie) WhatsApp messages:
  - "couple things for this week and some updates" — NOT "on deck this week" (sounds corporate)
  - "All the info is in [that thing]" — reference the actual artifact (script, doc, PDF) the creator already has
  - "You got Sintra signed" — past-action attribution to the creator, makes them feel ownership (NOT passive "Sintra is signed")
  - "the more time we will have to work with on edits" — concrete REASON for urgency, NOT vague "the better"
  - "they'd like" / "they want" — brand attribution as a separate party, not "the brand wants"
  - Soft asks with question marks: "what you would put for a caption?" — invites without demanding
  - CHANNEL-DIFFERENTIATED BULLETS:
    * WhatsApp messages → use plain "-" (hyphen) bullets, native to phone keyboard
    * Email messages → use "·" (middle dot) bullets, cleaner in Gmail typography
  - WhatsApp closer: "Lmk if you need anything else!" — with EXCLAMATION (warm + friendly with the creator)
  - Email closer: "Let me know." / "Lmk." — NO exclamation (professional with brands)
  - Creator messages can use friendly contractions ("Lmk", "Yo", "Btw") that wouldn't fly in brand emails.

CREATOR vs BRAND MESSAGE TONE:
  - Brand emails = professional warmth, no slang, "Let me know." / "Riley" closer
  - Creator WhatsApp = friendly + casual, "Yo" / "Lmk!" closers, exclamation marks OK
  - Always: no em-dashes, no scarcity framing, no creative angle proposals

PUNCTUATION RULES (HARD BAN):
- NEVER use em dashes (—) anywhere. Use commas to connect related clauses.
  WRONG: "Appreciate the feedback — passing it along to Cooper now."
  RIGHT: "Appreciate the feedback on the script and the production reminders, will be passing all of that along to Cooper now."
  WRONG: "We can do $4,500 — just let me know."
  RIGHT: "We can do $4,500, just let me know."
- NEVER use en dashes (–) or fancy quotes ("" '') — use plain - and "" ''.
- Use commas to link two related thoughts in one sentence rather than splitting into two short sentences. Riley writes like he talks.

BANNED PHRASES (these scream AI — never use):
- "I appreciate" — but "Appreciate the [thing]" with a follow-on clause IS fine (Riley uses it)
- "Looking forward to hearing your thoughts" / "your feedback"
- "Circling back" / "Just wanted to check in" / "Touching base"
- "Hope this finds you well" / "Hope you're doing well"
- "Please don't hesitate to" / "Feel free to"
- "I wanted to reach out"
- "honestly" used as a softener
- "land well with [creator]'s audience"
- "Thank you for your patience" / "Thanks for understanding"
- "More than happy to" (but plain "Happy to" IS fine — Riley uses it casually)
- "in-feed post" — say just "post"

SCARCITY FRAMING (HARD BAN — Riley's strategy is deal-hungry, target $10-15K/month per creator):
- NEVER say or imply the creator's calendar is busy / committed / packed / locked. That's scarcity framing that shrinks the pipeline.
- WRONG: "Cooper's calendar is mostly committed through mid-July"
- WRONG: "Cooper's June calendar is fully committed"
- WRONG: "earliest clean window is..."
- RIGHT: "July 10-14 or July 17-21 both work, let me know what fits the brand"
- RIGHT: "We can lock that window, just send the brief"
- If a real conflict exists (exclusivity clash, same-cat posting within 5 days), say "we'd want at least a week between that and X" — never use "committed" / "booked" / "busy" framing.

CREATIVE ANGLE BAN (Riley is the dealmaker, NOT the creative director):
- NEVER propose hooks, content angles, framings, "how the creator could position this", or what story to tell.
- The BRAND briefs the angle. The CREATOR executes it. Riley negotiates the deal.
- WRONG: "Cooper could lean into a builder workflow angle, showing how he uses Hailuo for B-roll"
- WRONG: "The right hook here is to show real use cases"
- WRONG: "I'd suggest framing it as..."
- RIGHT: Skip the paragraph entirely. Talk only about scope, fee, timing, terms, deliverables.
- If a brand objects to audience fit, address it commercially (price, scope adjustment, deliverable mix) — not by proposing creative direction.

DATE FORMAT (Riley writes dates like a human, not like a calendar app):
- ALWAYS full month names: "June 23", "July 10-14", "August 1".
- NEVER abbreviated: "Jun 23", "Jul 10-14", "Aug 1".
- Year only when it's ambiguous (different year than current context).

OPENING (vary it — never always "Hey [Name],"):
- For a counter / hard ask: lead with the point. "We can do $4,500 for the two Reels..."
- For a nudge: "Quick one — any movement on..." or "Following up — where did you land on..."
- For a yes: "Sounds good. Let's lock it in."
- For a hard pushback: "Want to be straight with you — the budget gap is too wide here."
- Only use "Hey [Name]," when actually warming up a new conversation.

CLOSING:
- One short line max. "Let me know." / "Lmk what works." / "Send the brief and we'll move." / "Ready when you are."
- NEVER end with "Looking forward to..." or "Happy to discuss further".
- Sign-off: Best,\\nRiley

NEGOTIATION RULES:
- Cooper IG Reel: $4,000 standard / $3,000 floor. Stories: TBD.
- Charlie: IG Reel $4,500 / TikTok $2,500 / Story $1,500 / UGC $1,000. Floor $1,000.
- Counter once. Never twice. If brand counters our counter, walk to creative ground (trim scope) not lower $.
- Push for ZERO exclusivity. Accept up to 30 days same-cat if brand insists. 90+ is a redline.
- Recurring deals: plant the seed early ("worth running one as a test first?") — don't push hard.
- Net 30 default. Net 60+ accept reluctantly. Net 90+ flag as redline.

RED LINES (flag — don't auto-accept):
- Perpetual usage at standard rate. Exclusivity >90d. Net 90+. Gambling/crypto/MLM. Personal info before contract. Anything below floor.

OUTPUT FORMAT:
- ONLY the email body. No subject line, no preamble, no "Here's a draft:".
- Plain text. Newlines for paragraph breaks.
- 3-5 sentences for a normal reply. 1-3 for a nudge. Hard cap.
- End with sign-off: Best,\\nRiley
`;

// Pull Riley's recent outbound emails (his actual voice) so the AI can mimic
// real patterns instead of defaulting to corporate template. Cached on first
// call per process — voice doesn't change every minute.
let _voiceSamplesCache = null;
let _voiceSamplesCachedAt = 0;
function loadVoiceSamples(db) {
  if (!db) return '';
  const now = Date.now();
  if (_voiceSamplesCache && (now - _voiceSamplesCachedAt) < 3600_000) return _voiceSamplesCache;
  try {
    const rows = db.prepare(`
      SELECT body FROM messages
      WHERE from_us = 1 AND channel = 'email'
        AND body IS NOT NULL AND length(body) BETWEEN 150 AND 1500
        AND body NOT LIKE '%---%'
        AND body NOT LIKE '%unsubscribe%'
      ORDER BY sent_at DESC LIMIT 5`).all();
    if (!rows.length) { _voiceSamplesCache = ''; _voiceSamplesCachedAt = now; return ''; }
    // Strip quoted chains, trim, label
    const samples = rows.map((r, i) => {
      let b = r.body;
      try { b = stripQuotedReply(b) || b; } catch {}
      // Hard trim — keep ~10 lines max
      b = b.replace(/\s+/g, ' ').trim().slice(0, 800);
      return `EXAMPLE ${i+1}: "${b}"`;
    }).join('\n\n');
    _voiceSamplesCache = `\n\nRILEY'S ACTUAL VOICE — recent emails he sent. Mimic this tone, length, directness:\n${samples}\n`;
    _voiceSamplesCachedAt = now;
    return _voiceSamplesCache;
  } catch (e) {
    return '';
  }
}

// Pull the creator's currently committed posting dates from the DB. Injected
// into every Cook prompt so the AI never invents windows ("we're holding Jun
// 23-30 for another deal" when no such deal exists). Excludes the current
// deal itself + completed/cold deals. Window: today through 90d out.
function loadHolds(db, creator_id, excludeDealId) {
  if (!db || !creator_id) return '';
  try {
    const rows = db.prepare(`
      SELECT id, brand, funnel_stage, state, posting_date, posting_window_start, posting_window_end,
             fee_cents, json_extract(extra, '$.deliverable') as deliverable
      FROM deals
      WHERE creator_id = ?
        AND id != COALESCE(?, '')
        AND funnel_stage NOT IN ('completed','cold','dormant')
        AND (state='won' OR funnel_stage IN ('in_works','signed','agreed'))
        AND COALESCE(posting_date, posting_window_start) IS NOT NULL
        AND COALESCE(posting_date, posting_window_start) >= date('now', '-3 days')
        AND COALESCE(posting_date, posting_window_start) <= date('now', '+120 days')
      ORDER BY COALESCE(posting_date, posting_window_start) ASC
    `).all(creator_id, excludeDealId || '');
    if (!rows.length) {
      return `\nCURRENTLY COMMITTED DATES for ${cap(creator_id)}: none in the next 120 days. The calendar is OPEN — be welcoming on timing, do not invent fake holds.\n`;
    }
    const fmt = (iso) => {
      if (!iso) return '';
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const [y,m,d] = iso.split('T')[0].split('-').map(Number);
      return `${months[m-1]} ${d}`;
    };
    const lines = rows.map(r => {
      const start = r.posting_date || r.posting_window_start;
      const end = (r.posting_window_end && r.posting_window_end !== start) ? r.posting_window_end : null;
      const dateLabel = end ? `${fmt(start)}-${fmt(end).split(' ')[1] || fmt(end)}` : fmt(start);
      const stage = r.state === 'won' ? 'locked' : (r.funnel_stage === 'in_works' ? 'in production' : r.funnel_stage);
      const deliverable = (r.deliverable || '').slice(0, 60);
      return `- ${dateLabel}: ${r.brand} (${stage}${deliverable ? ', ' + deliverable : ''})`;
    });
    return `
CURRENTLY COMMITTED DATES for ${cap(creator_id)} (THESE are the ONLY real holds — never invent others, never say "calendar is committed"):
${lines.join('\n')}

Rules when discussing timing:
- Only reference dates from the list above. Never make up windows like "we're holding X for another deal" if not listed.
- Spacing target: 5-7 days minimum between sponsored posts. If a brand asks for a date within 5 days of a listed hold, suggest a date that gives proper spacing.
- If no listed hold conflicts, the date is OPEN. Be welcoming, not protective.
- NEVER use "mostly committed", "calendar is full", "fully committed" or similar scarcity language — see PLAYBOOK scarcity ban.
`;
  } catch (e) {
    return '';
  }
}

export class OpenAIDraftProvider {
  constructor(db, spend) { this.db = db; this.spend = spend; }

  async draft({ deal, latestMessage = null, mode = 'counter', customInstruction = null, threadHistory = [], waHistory = [] }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY missing in .env');

    // NUDGE FATIGUE: when Riley has already sent 2+ messages in a row with no
    // brand reply between them, another "just following up" is wasted breath
    // (and looks desperate). Override the mode to last_touch — graceful door-
    // open close instead of another chase.
    if (mode === 'nudge_follow_up' || mode === 'gentle_nudge') {
      let consecutiveOurs = 0;
      for (let i = (threadHistory || []).length - 1; i >= 0; i--) {
        if (threadHistory[i].from_us) consecutiveOurs++;
        else break;
      }
      if (consecutiveOurs >= 2) {
        mode = 'last_touch';
      }
    }

    let sug = suggestPrice(deal);
    // RILEY'S OWN ANCHOR CAP — if he has stated $ figures in this thread
    // already (e.g. "standard $2,000, floor $1,500"), the new draft cannot
    // exceed his highest stated number. Prevents the Zingroll bug where the
    // nudge engine proposed $3k after Riley had anchored at $2k/$1.5k.
    const rileyAnchor = extractRileyThreadAnchors(threadHistory);
    if (rileyAnchor.max_cents && sug.suggested_cents && sug.suggested_cents > rileyAnchor.max_cents) {
      sug = {
        ...sug,
        suggested_cents: rileyAnchor.max_cents,
        anchor_cents: rileyAnchor.max_cents,
        // Tighten floor too if Riley stated a lower number explicitly.
        floor_cents: rileyAnchor.min_cents && rileyAnchor.min_cents < (sug.floor_cents || Infinity)
          ? rileyAnchor.min_cents : sug.floor_cents,
        reasoning: `Capped at $${Math.round(rileyAnchor.max_cents/100).toLocaleString()} — Riley already anchored at this rate in the thread; do not propose a higher number.`,
        _thread_anchored: true,
      };
    }
    // Include the custom instruction in dedupe so different voice-noted
    // instructions on the same thread cook fresh drafts (not the same draft).
    const dedupe_key = `draft:${deal.id}:${mode}:${(latestMessage?.id || deal.latest_msg_id || '')}:${customInstruction ? hash(customInstruction) : ''}:${Date.now()}`;
    const gate = this.spend.attempt({ dedupe_key });
    if (!gate.ok) throw new Error('SpendGuard blocked draft: ' + gate.reason);

    const holds = loadHolds(this.db, deal.creator_id, deal.id);
    const userPrompt = buildPrompt({ deal, latestMessage, mode, sug, customInstruction, threadHistory, waHistory, holds });
    // Pull Riley's actual outbound voice samples and prepend to the system playbook
    const voiceSamples = loadVoiceSamples(this.db);
    const systemContent = PLAYBOOK + voiceSamples;
    const t0 = Date.now();
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        temperature: 0.55,
        max_tokens: 500,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user',   content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`OpenAI ${res.status}: ${t.slice(0,200)}`);
    }
    const data = await res.json();
    const body = data.choices?.[0]?.message?.content?.trim() || '';
    const usage = data.usage || {};
    // gpt-4o pricing (as of 2026 May): $2.50 / 1M input, $10 / 1M output -> cents:
    const est_cost_cents =
        Math.round((usage.prompt_tokens || 0) * 0.00025) +
        Math.round((usage.completion_tokens || 0) * 0.001);
    this.spend.record({
      provider: 'openai', model: 'gpt-4o', operation: 'draft',
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      est_cost_cents,
      deal_id: deal.id,
      dedupe_key,
    });

    return {
      body,
      subject: deal.primary_channel === 'email'
        ? `Re: ${deal.brand} × ${cap(deal.creator_id)}` : null,
      rationale: `OpenAI gpt-4o · mode=${mode} · ` + (sug.suggested_cents
        ? `suggested $${(sug.suggested_cents/100).toLocaleString()} (floor $${(sug.floor_cents/100).toLocaleString()}, anchor $${(sug.anchor_cents/100).toLocaleString()})`
        : 'no rate suggestion'),
      suggested_price_cents: sug.suggested_cents,
      generated_by: 'openai:gpt-4o',
      latency_ms: Date.now() - t0,
      cost_cents: est_cost_cents,
    };
  }
}

export class OpenAIParseProvider {
  constructor(db, spend) { this.db = db; this.spend = spend; }
  async classifyIntent(text) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY missing in .env');
    const dedupe_key = `intent:${hash(text)}`;
    const gate = this.spend.attempt({ dedupe_key });
    if (!gate.ok) return { intent: 'unknown', confidence: 0, error: gate.reason };

    const sys = `Classify a short Riley command into a JSON intent. Possible intents:
- log_payment {amount_cents, brand, deal_id?}: brand paid an invoice
- send_message {creator_id, message, channel}: ask to draft an outbound msg
- flag_deal {brand, note}: add a red-line / risk note
- reminder {text, due_at(ISO date)}: schedule a reminder
- change_stage {brand, to(cold|conversation|pitching|in_works|active|completed)}
- query {q}: question about pipeline
- note {text}: catch-all
Return ONLY {"intent": "...", "confidence": 0-1, ...fields}. No prose.`;
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.1,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0,200)}`);
    const data = await res.json();
    const usage = data.usage || {};
    // gpt-4o-mini: $0.15 / 1M input, $0.60 / 1M output -> cents:
    const est_cost_cents =
        Math.round((usage.prompt_tokens || 0) * 0.000015) +
        Math.round((usage.completion_tokens || 0) * 0.00006);
    this.spend.record({
      provider: 'openai', model: 'gpt-4o-mini', operation: 'classify',
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      est_cost_cents,
      dedupe_key,
    });
    let intent = {};
    try { intent = JSON.parse(data.choices?.[0]?.message?.content || '{}'); }
    catch { return { intent:'note', confidence:0.3, text }; }
    // Resolve brand -> deal_id if mentioned
    if (intent.brand) {
      const row = this.db.prepare('SELECT id, brand, creator_id FROM deals WHERE LOWER(brand) LIKE ?').get('%' + intent.brand.toLowerCase() + '%');
      if (row) { intent.deal_id = row.id; intent.creator_id ||= row.creator_id; }
    }
    return { ...intent, _cost_cents: est_cost_cents };
  }
}

const MODE_INSTRUCTIONS = {
  counter:           'Mode: COUNTER. Anchor at the target fee, mention any usage/exclusivity/timing concerns from flags.',
  ask_brief:         'Mode: ASK FOR BRIEF. Acknowledge their reach-out warmly, then ask for: full brief / creative direction, posting window, usage rights, exclusivity, payment terms. Promise a tight quote once received.',
  chase_contract:    'Mode: CHASE CONTRACT. Verbal yes was reached; politely ask for the contract / paperwork so we can lock the booking and start production.',
  flag_contract_mismatch: 'Mode: FLAG CONTRACT MISMATCH. The contract has issues vs the agreed terms (see flags/notes — e.g. blank fields, wrong dates, fee discrepancy). Politely point out the specific issue(s) and ask them to correct & resend.',
  request_signature: 'Mode: REQUEST SIGNATURE. Contract is ready; ask them to countersign / send the signed version back, confirm next steps.',
  acknowledge_progress: 'Mode: ACKNOWLEDGE PROGRESS. The brand has moved things forward (contract sent, DocuSign issued, brief delivered, etc.). Do NOT re-ask for terms or quote — terms are agreed. Briefly thank them, confirm what we will do next (sign the agreement, deliver on the agreed timeline, etc.), and reference any specific detail from their message (e.g. who they sent the DocuSign to, the posting date, the deliverable). Keep it short — 3-4 sentences max.',
  payment_followup:  'Mode: PAYMENT FOLLOWUP. Production/signing done; we need them to confirm payee info / payment routing. Offer to send W-9 + remittance details + invoice. Use the actual payment_terms_days from the deal context — do NOT fabricate net terms if none are stated.',
  chase_payment:     'Mode: CHASE PAYMENT. Invoice is out and due. Polite, professional check-in. ONLY cite an invoice number if you see one in the thread above — do NOT fabricate an invoice number. If no number is visible, reference "the invoice" generically.',
  gentle_nudge:      'Mode: GENTLE NUDGE. Thread has gone quiet, ball was on brand. Friendly check-in, restate the existing offer if needed, do NOT propose a new number. Offer a quick call if easier.',
  last_touch:        'Mode: LAST TOUCH. Riley has already followed up two or more times with no brand reply. Do NOT send another "just following up" — they have seen the prior nudges. Instead: graceful, low-pressure note that takes pressure off, leaves the door open for later, and frees up his mental energy to move on. Acknowledge they may be heads down. Offer to revisit when timing improves. NO new offers, NO new numbers, NO urgency. 3 sentences max.',
  nudge_follow_up:   'Mode: NUDGE FOLLOW UP. Quick check-in on the existing offer. Restate what we are waiting on (e.g. "any movement on the budget?" or "where did you land on the package?"). Do NOT propose a new number. Keep it 1-3 sentences.',
  channel_switch:    'Mode: CHANNEL SWITCH. Offer to move the conversation to WhatsApp for faster turnaround.',
  custom_instruction:'Mode: CUSTOM. Riley gave specific guidance in the RILEY SAID block — convey EXACTLY that, nothing more. Write a SHORT, focused email (3-4 sentences). Add greeting + signature, but do NOT include fee anchors, negotiation moves, rate proposals, or extra info Riley did not explicitly ask you to include. If Riley\'s message is just an update, keep it light and informational. Do not invent commitments.',
};

// Scan Riley's prior outbound in this thread for the OPERATIVE standing anchor —
// the most recent $ he committed to. Used as the ceiling for any draft cooked
// later in the thread, so the AI can't walk a counter back up.
//
// Why "most recent" not "max across thread":
//   - Similarweb bug: Riley quoted $2,500 at intro, then countered down to
//     $1,700 after Rachel offered $1k. A naive max would cap at $2,500 and
//     let the nudge re-propose $2,500, undoing his counter.
//   - The latest number Riley committed to IS the standing offer. Anything
//     higher requires explicit scope expansion he authored.
//
// Heuristic:
//   1. Walk Riley's outbound from newest to oldest
//   2. First message containing a $ figure in the sane band wins
//   3. From that message: max = standing anchor, min = explicit floor (if any)
//
// Sane $ band: $300 to $50,000 (filters phone numbers, promo codes, dates).
function extractRileyThreadAnchors(threadHistory) {
  if (!threadHistory || !threadHistory.length) return { max_cents: null, min_cents: null };
  // Newest-to-oldest scan of Riley's messages
  for (let i = threadHistory.length - 1; i >= 0; i--) {
    const m = threadHistory[i];
    if (!m.from_us) continue;
    let body = m.body || m.snippet || '';
    if (m.channel === 'email' && body) {
      try { body = stripQuotedReply(body) || body; } catch {}
    }
    if (!body) continue;
    const cents = [...body.matchAll(/\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)(?!\d)/g)]
      .map(x => Math.round(parseFloat(x[1].replace(/,/g,''))*100))
      .filter(c => c >= 30_000 && c <= 5_000_000);
    if (!cents.length) continue;
    // Found Riley's latest message with $ — return its anchors.
    return { max_cents: Math.max(...cents), min_cents: Math.min(...cents) };
  }
  return { max_cents: null, min_cents: null };
}

// Format a message list as a readable conversation log.
function formatThread(history, label) {
  if (!history || !history.length) return '';
  const lines = history.map(m => {
    const sender = m.from_us ? 'Riley (us)' : (m.sender ? m.sender.split('<')[0].trim().replace(/"/g,'').slice(0,40) : 'brand');
    const when = (m.sent_at || '').slice(0,16).replace('T',' ');
    // CRITICAL: strip quoted reply chain so 20 stacked messages don't all
    // contain the same prior thread inline. The AI's context budget is precious.
    let body = m.body || m.snippet || '';
    if (m.channel === 'email' && body) {
      try { body = stripQuotedReply(body) || body; } catch {}
    }
    body = body.replace(/\s+/g,' ').trim().slice(0, 1500);
    return `[${when}] ${sender}: ${body}`;
  });
  return `\n${label} (oldest → newest):\n${lines.join('\n')}\n`;
}

function buildPrompt({ deal, latestMessage, mode, sug, customInstruction = null, threadHistory = [], waHistory = [], holds = '' }) {
  const creator = cap(deal.creator_id);
  const fee = sug.suggested_cents ? `$${(sug.suggested_cents/100).toLocaleString()}` : 'TBD';
  const floor = sug.floor_cents ? `$${(sug.floor_cents/100).toLocaleString()}` : '';
  const modeNote = MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS.counter;
  // Include banking/payee details when the mode involves sending payment info.
  const NEEDS_PAYMENT_INFO = ['payment_followup', 'chase_payment', 'acknowledge_progress', 'request_signature'];
  const paymentBlock = NEEDS_PAYMENT_INFO.includes(mode) ? formatPaymentBlock(loadPaymentInfo()) : '';
  const ctx = `
${modeNote}
${paymentBlock}

DEAL CONTEXT
- Brand: ${deal.brand}
- Creator: ${creator}
- Contact: ${deal.contact_name || 'unknown'} (${deal.contact_role || 'rep'})${deal.agency ? ' @ ' + deal.agency : ''}
- Stage: ${deal.funnel_stage}, ball in: ${deal.ball_in_court || '?'}
- Category: ${deal.category || '?'}
${mode === 'custom_instruction' ? '' : `- Current asked fee: ${deal.fee_cents ? '$' + (deal.fee_cents/100).toLocaleString() : 'none yet'}
- My target for this reply: ${fee} (floor ${floor})
- Reasoning: ${sug.reasoning || ''}`}
- Active flags: ${(deal.flags || []).slice(0,8).join(', ') || 'none'}
- Posting date: ${deal.posting_date || 'TBD'}, Exclusivity: ${deal.exclusivity_days ? deal.exclusivity_days + 'd' : 'none'}
- Channel: ${deal.primary_channel || 'email'}

MODE: ${mode}
${holds}
${formatThread(threadHistory, 'EMAIL THREAD')}
${formatThread(waHistory, 'WHATSAPP CHAT (related conversation — use for context only, do NOT cite directly)')}
${customInstruction ? `RILEY SAID (honor this — it's what he wants the reply to convey):\n"${customInstruction}"\n` : ''}
Write Riley's reply. Plain text. Sign-off: Best,\\nRiley Wallack\\nTriibe Talents (this is his standard email signature — keep the 3 lines).
Use the full thread above to maintain context, references, and tone. Do not repeat questions that have already been answered.

THREAD AWARENESS (critical):
- BEFORE writing, scan every message above. Note what's been agreed (rate, deliverables, timeline, exclusivity).
- If Riley has stated a number in the thread — "$X standard / $Y floor" or any explicit anchor — you MUST stay at or BELOW his highest stated number. NEVER propose a higher rate after Riley has already anchored. The only exceptions are if scope has DEMONSTRABLY expanded (extra deliverable added, longer exclusivity asked, etc.) AND brand requested that expansion.
- Don't pull a number out of thin air — if a rate has been mentioned in-thread by Riley, reference it (e.g. "as I mentioned, $X for a dedicated Reel").
- If brand wrote in non-USD currency (£/€/¥), reply in the SAME currency they used unless we've already established USD as the deal currency.
- Don't ask for info we already have (their budget, scope, posting date) if the thread shows it.
- If this is the first reply (no prior Riley message in thread), open by sharing our rate card breakdown — don't dance around it.
${sug._thread_anchored ? `\nANCHOR LOCK: Riley has already anchored at $${(sug.anchor_cents/100).toLocaleString()} in this thread. DO NOT propose a number higher than this. Either restate this rate, restate the floor ($${(sug.floor_cents/100).toLocaleString()}), or hold without a new number.\n` : ''}`;
  return ctx;
}

function cap(s) { return s ? (s[0].toUpperCase() + s.slice(1)) : s; }
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h<<5)-h) + s.charCodeAt(i) | 0; return Math.abs(h).toString(36); }
