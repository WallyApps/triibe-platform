// Cook posture engine — returns 2-4 strategy chips Riley picks BEFORE the AI
// drafts a reply. Each posture is a (label, hint, prompt_addendum) tuple. The
// addendum gets injected into the system prompt so the AI knows the angle.
//
// Design rules:
//   - Skip the chip step (return []) when there's no real strategic choice
//     — e.g. "Sintra sent the signed contract, send a thank you" is one
//     obvious move; chips would just add friction.
//   - 2-4 chips max. More than 4 is decision fatigue.
//   - First chip is the recommended default (Riley sees it pre-selected).
//   - prompt_addendum is plain text appended to the user prompt. It overrides
//     the mode-default behavior — keep it sharp and directive.

import { stripQuotedReply } from '../providers/inbound.gmail.js';

const $$ = c => '$' + Math.round((c || 0) / 100).toLocaleString();

// Walk thread for most recent brand $ and most recent Riley $ — used to detect
// rate-negotiation state. Mirrors the logic in draft.openai.js but stays here
// so postures.js is standalone.
function lastDollars(history, fromUs) {
  if (!history?.length) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!!m.from_us !== fromUs) continue;
    let body = m.body || m.snippet || '';
    if (m.channel === 'email' && body) {
      try { body = stripQuotedReply(body) || body; } catch {}
    }
    const cents = [...(body || '').matchAll(/\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)(?!\d)/g)]
      .map(x => Math.round(parseFloat(x[1].replace(/,/g, '')) * 100))
      .filter(c => c >= 30_000 && c <= 5_000_000);
    if (cents.length) return Math.min(...cents);  // lowest (treat brand high-low as offer)
  }
  return null;
}

// Riley used pushback language without naming a higher number?
function detectUnpricedPushback(history) {
  if (!history?.length) return false;
  let lastUs = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].from_us) { lastUs = history[i]; break; }
  }
  if (!lastUs) return false;
  let body = lastUs.body || lastUs.snippet || '';
  if (lastUs.channel === 'email' && body) {
    try { body = stripQuotedReply(body) || body; } catch {}
  }
  const pushbackRe = /\b(below where|under (?:where|our)|lower than|less than|not (?:workable|enough)|standard|typically (?:prices|charges|sits|lands)|floor|minimum|north of|push(?:ed|ing)? back|transparent though|honest with you|short of|gap|too (?:low|tight|wide))\b/i;
  return pushbackRe.test(body);
}

function consecutiveOurs(history) {
  if (!history?.length) return 0;
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].from_us) n++;
    else break;
  }
  return n;
}

/**
 * Compute posture options for a deal.
 *
 * @param {object} args
 * @param {object} args.deal       merged deal row
 * @param {array}  args.history    full message history (oldest → newest)
 * @param {object} args.rateCard   per-creator rate card (for floor refs)
 * @returns {Array<{id,label,hint,prompt_addendum,recommended?:boolean}>}
 */
export function computePostures({ deal, history = [], rateCard = null }) {
  const stage = deal.funnel_stage || '';
  const raw   = deal.raw_stage || '';
  const ball  = deal.ball_in_court || '';
  const state = deal.state || 'open';
  const brandCents = lastDollars(history, false);
  const ourCents   = lastDollars(history, true);
  const pushedBack = detectUnpricedPushback(history);
  const consecMine = consecutiveOurs(history);
  const ourFloor   = rateCard?.[deal.creator_id]?.floor_cents || null;
  const ourAnchor  = rateCard?.[deal.creator_id]?.ig_reel_cents || null;

  // === Revival / cold thread — fires BEFORE the negotiation branches.
  // When a thread has gone cold (last message 14+ days old) OR the deal was
  // parked and just unparked, the right opening play is a friendly circle-
  // back, not a negotiation tactic. The negotiation chips assume a live back-
  // and-forth — for a 20-day silent thread they read as out-of-touch.
  const lastMsg = history.length ? history[history.length - 1] : null;
  const lastAt  = lastMsg?.sent_at ? new Date(lastMsg.sent_at).getTime() : null;
  const daysSilent = lastAt ? Math.floor((Date.now() - lastAt) / 86400_000) : null;
  const justRevived = !!deal.revived_at;  // unpark stamps this
  if (state === 'dormant' || (daysSilent != null && daysSilent >= 14) || justRevived) {
    return [
      { id: 'circle_back', recommended: true,
        label: '👋 Circle back',
        hint: 'Friendly check-in, ask for an update',
        prompt_addendum: `Posture: Thread has been quiet${daysSilent ? ` (${daysSilent} days)` : ''}. Friendly, low-pressure circle-back. Acknowledge it's been a minute, ask where they landed / if anything moved on their end / if it's still on the table. NO new offers, NO rate proposals, NO urgency. 2 sentences max. Reference what we left off on if helpful.` },
      { id: 'new_angle',
        label: '💡 New angle',
        hint: 'Bring a fresh hook to revive interest',
        prompt_addendum: `Posture: Use a NEW angle to revive a cold thread. Examples: "Cooper just posted a Reel that lit up our analytics, thought of you" / "We're filling our ${new Date().toLocaleString('en-US',{month:'long'})} calendar and wanted to check if your timing has shifted." Warm tone, bring a reason to re-engage. Up to 3 sentences. No new $ numbers unless we're moving rates.` },
      { id: 'flex_on_terms',
        label: '🤝 Flex on terms',
        hint: 'Signal openness on structure / scope',
        prompt_addendum: `Posture: Signal flexibility WITHOUT capitulating on rate. Suggest we're open to discussing scope variations (deliverable mix, timeline, payment terms, exclusivity ask) if their original budget was the blocker. Do NOT name a new $ figure. Frame as "happy to find a structure that works on your side." 2-3 sentences.` },
      { id: 'last_touch',
        label: '🚪 Last touch',
        hint: 'Graceful close, leave door open',
        prompt_addendum: `Posture: Final, low-pressure note. Acknowledge it's been a minute and assume bandwidth shifted. Tell them we're closing the loop on our end but if anything frees up later, the door is open. NO new offers. NO follow-up promised. 2-3 sentences.` },
    ];
  }

  // === Sign / contract chase ===
  if (raw === 'terms_agreed' || raw === 'terms_agreed_pending_client' || stage === 'in_works' && !raw.includes('signed') && !raw.includes('contract')) {
    return [
      { id: 'gentle_nudge', recommended: true,
        label: '👋 Gentle nudge',
        hint: 'Friendly check-in on contract status',
        prompt_addendum: 'Posture: Light, no pressure. Just checking in on where the contract sits. 1-2 sentences max.' },
      { id: 'add_urgency',
        label: '⚡ Add urgency',
        hint: 'Reference posting timeline, push for paper',
        prompt_addendum: 'Posture: Add a real reason for urgency. Reference posting date / production timeline / locked calendar slot. Ask them to get the contract over today or tomorrow so we can start prepping. Polite but direct.' },
      { id: 'offer_to_draft',
        label: '📄 Offer to draft it',
        hint: "Send our boilerplate to unblock them",
        prompt_addendum: 'Posture: Offer to send our boilerplate contract so they don\'t have to draft from scratch. Frame as helpful, not pushy. Ask who should we send it to.' },
    ];
  }

  // === Payment chase ===
  if (raw === 'invoice_sent' || raw === 'awaiting_payment' || (deal.state === 'won' && (deal.fee_cents || 0) > 0 && (deal.paid_cents || 0) < (deal.fee_cents || 0))) {
    return [
      { id: 'friendly_payment', recommended: true,
        label: '💰 Friendly check-in',
        hint: 'Low-pressure status ask',
        prompt_addendum: 'Posture: Casual check-in on payment status. Reference invoice/PO if visible in thread. No "second notice" energy.' },
      { id: 'firm_chase',
        label: '⏰ Firm chase',
        hint: 'Reference due date + escalation if needed',
        prompt_addendum: 'Posture: Polite but firm. Reference the agreed net terms / due date. State that payment is past due and ask for an ETA. Mention we may need to escalate to finance/accounts if unresolved.' },
      { id: 'offer_call',
        label: '📞 Offer a call',
        hint: 'De-escalate via voice',
        prompt_addendum: 'Posture: Offer to hop on a quick call to sort the payment routing. Sometimes paper-trail issues are easier to resolve verbally. Keep it light.' },
    ];
  }

  // === Pitching stage with brand $ on the table ===
  if (stage === 'pitching' && brandCents && state !== 'won') {
    const chips = [];
    // If Riley already pushed back without numbering, lock the next move:
    if (pushedBack && (ourCents == null || ourCents <= brandCents)) {
      chips.push(
        { id: 'reinforce_pushback', recommended: true,
          label: '🪨 Hold firm (no number)',
          hint: 'Reinforce the pushback, no $ figure',
          prompt_addendum: 'Posture: We already pushed back on their rate without naming a new number. Reinforce that. DO NOT name any $ figure. Frame as "any flexibility on the budget" or "where you landed on the rate." Keep pressure on them.' },
        { id: 'counter_at_floor',
          label: `🎯 Counter at floor${ourFloor ? ' (' + $$(ourFloor) + ')' : ''}`,
          hint: 'Drop a real number to anchor',
          prompt_addendum: `Posture: Make a counter. Drop a specific dollar amount at the creator\'s floor${ourFloor ? ' of ' + $$(ourFloor) : ''}. Frame as where we can land to make this work. Explicitly state the new $ figure.` },
        { id: 'walk_away',
          label: '👋 Last touch / walk',
          hint: 'Graceful door-open close',
          prompt_addendum: 'Posture: Walk away gracefully. Acknowledge their budget doesn\'t fit but leave the door open for future campaigns. No new numbers, no pressure. 2 sentences.' },
      );
    } else {
      // Brand $ on the table, we haven't pushed yet
      const tooLow = ourFloor ? brandCents < ourFloor : (ourAnchor ? brandCents < ourAnchor * 0.75 : false);
      chips.push(
        { id: 'push_higher', recommended: tooLow,
          label: '📈 Push for higher',
          hint: 'Rate is below our standard, push back',
          prompt_addendum: `Posture: Brand offered ${$$(brandCents)} which is below our standard${ourAnchor ? ' (' + $$(ourAnchor) + ')' : ''}. Push back firmly but professionally. Cite our typical rate context. DO NOT accept their number; ask them to revisit on their end.` },
        { id: 'counter_at_floor',
          label: `🎯 Counter at floor${ourFloor ? ' (' + $$(ourFloor) + ')' : ''}`,
          hint: 'Drop a real number to anchor',
          prompt_addendum: `Posture: Counter with a specific $ figure at the floor${ourFloor ? ' of ' + $$(ourFloor) : ''}. Frame as where we can make it work. Be direct about the number.` },
        { id: 'accept_and_lock', recommended: !tooLow,
          label: '✅ Accept & lock',
          hint: 'Take the deal, push to paper',
          prompt_addendum: `Posture: Accept ${$$(brandCents)} as agreed. Confirm scope quickly and pivot to "send the contract over and we\'ll lock the post date." Energy = excited to move forward.` },
        { id: 'hold_no_number',
          label: '🤐 Hold (no number)',
          hint: 'Acknowledge, ask for more context',
          prompt_addendum: 'Posture: Don\'t name a $ figure yet. Acknowledge their offer, ask for more campaign detail (deliverables breakdown, exclusivity, usage, timeline) before quoting. Buy time to decide.' },
      );
    }
    return chips.slice(0, 4);
  }

  // === Cold conversation / no $ on table yet ===
  if (stage === 'pitching' || stage === 'conversation') {
    return [
      { id: 'ask_for_brief', recommended: true,
        label: '📋 Ask for brief',
        hint: 'Get the full scope before quoting',
        prompt_addendum: 'Posture: Acknowledge their reach-out warmly. Ask for: full brief / creative direction, posting window, usage rights, exclusivity, payment terms. Promise a tight quote once received.' },
      { id: 'send_rate_card',
        label: '💲 Send rate card',
        hint: 'Open with our standard numbers',
        prompt_addendum: `Posture: Open with our standard rates upfront so they know where we land. Quote ${ourAnchor ? $$(ourAnchor) + ' for a dedicated Reel' : 'our standard rate for a dedicated Reel'}. Ask what they have budgeted and what the scope is.` },
      { id: 'polite_decline',
        label: '🙏 Polite decline',
        hint: 'Not a fit, close warmly',
        prompt_addendum: 'Posture: Politely decline. Brand category / fit / timing doesn\'t work right now. Leave door open for future. 2 sentences.' },
    ];
  }

  // === Brand asked a substantive question / needs answer ===
  if (ball === 'us' && raw.includes('question')) {
    return [
      { id: 'answer_direct', recommended: true,
        label: '✓ Answer directly',
        hint: 'Address what they asked',
        prompt_addendum: 'Posture: Answer their question(s) directly and completely. No dodging, no extra fluff. End with one forward-momentum line.' },
      { id: 'answer_plus_ask',
        label: '🔄 Answer + counter-ask',
        hint: "Answer, then ask what's outstanding from them",
        prompt_addendum: 'Posture: Answer their question, then turn around with our own outstanding ask (contract, scope confirmation, posting date, etc). Move the ball back to them.' },
      { id: 'defer_to_call',
        label: '📞 Defer to call',
        hint: 'Suggest jumping on a quick call',
        prompt_addendum: 'Posture: Suggest a quick 10-15 min call to walk through their questions properly. Offer 2-3 time windows. Polite, easy.' },
    ];
  }

  // === Default — generic with no obvious strategic fork ===
  // If Riley has already followed up twice with no reply, force last-touch only.
  if (consecMine >= 2 && ball !== 'us') {
    return [
      { id: 'last_touch', recommended: true,
        label: '🚪 Last touch',
        hint: 'Graceful close, leave door open',
        prompt_addendum: 'Posture: Already followed up 2+ times. No more chase energy. Acknowledge they may be heads down, leave door open, no new numbers, no urgency. 3 sentences max.' },
    ];
  }

  // Generic 2-3 chips for everything else
  return [
    { id: 'standard_reply', recommended: true,
      label: '💬 Standard reply',
      hint: 'Cook a balanced response',
      prompt_addendum: 'Posture: Balanced, professional reply matching the thread context.' },
    { id: 'concise',
      label: '⚡ Quick & short',
      hint: '1-2 sentences only',
      prompt_addendum: 'Posture: Keep it under 2 sentences. Just the essential answer, no fluff.' },
    { id: 'detailed',
      label: '📝 Thorough',
      hint: 'Cover everything in detail',
      prompt_addendum: 'Posture: Be thorough. Cover scope, timeline, deliverables, anything else outstanding. Up to 5-6 sentences if needed.' },
  ];
}
