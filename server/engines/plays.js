// plays.js — the "brain" engine. Reads every signal across both creators'
// pipelines and surfaces the 5-7 highest-leverage actions for today.
//
// Two stages:
//   1) gatherSignals(): pure data — pulls candidates from DB with rule scoring
//   2) rankWithAI():    optional gpt-4o pass that re-orders + writes punchy
//                       one-liners ("Sintra contract 2d unsigned — sign + return").
//
// Used by /api/plays. Cached per-creator for 15 min unless deal state changes.

const DAY = 86400000;

function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
}

// Build the raw signal list. Each signal has:
//   kind, deal_id, brand, creator, urgency (1-100), value_cents, reason,
//   suggested_action (cook_reply | cook_nudge | sign_contract | send_invoice |
//                      claim_lead | resolve_clash | walk_away | review_counter)
export function gatherSignals({ db, creator }) {
  const signals = [];
  const creatorFilter = creator ? 'AND d.creator_id = ?' : '';
  const params = creator ? [creator] : [];

  // ---- 1. Contracts arrived but not yet signed (HIGH urgency) ----
  // Deal is in_works/contract_received but state isn't won yet → action: sign
  const unsignedContracts = db.prepare(`
    SELECT d.id, d.brand, d.creator_id, d.fee_cents, d.raw_stage, d.last_activity_at,
           c.created_at AS contract_at
    FROM deals d
    LEFT JOIN contracts c ON c.deal_id = d.id
    WHERE d.raw_stage = 'contract_received' AND d.state = 'open'
      ${creatorFilter}
    ORDER BY c.created_at DESC NULLS LAST`).all(...params);
  for (const d of unsignedContracts) {
    const age = daysSince(d.contract_at || d.last_activity_at);
    signals.push({
      kind: 'sign_contract',
      deal_id: d.id, brand: d.brand, creator: d.creator_id,
      urgency: age != null ? Math.min(50 + age * 8, 95) : 75,
      value_cents: d.fee_cents || 0,
      reason: age != null
        ? `Contract arrived ${age}d ago — sign + return to unlock $${((d.fee_cents||0)/100).toLocaleString()}.`
        : `Contract arrived — sign + return.`,
      suggested_action: 'sign_contract',
    });
  }

  // ---- 2. Brand-counter offers needing response ----
  // Pitching deals where brand sent a $ that differs from our quote
  const pitching = db.prepare(`
    SELECT d.id, d.brand, d.creator_id, d.fee_cents, d.ball_in_court, d.raw_stage,
           (SELECT body FROM messages m JOIN threads t ON t.id=m.thread_id
            WHERE t.deal_id=d.id AND m.from_us=0 ORDER BY m.sent_at DESC LIMIT 1) AS brand_msg,
           (SELECT sent_at FROM messages m JOIN threads t ON t.id=m.thread_id
            WHERE t.deal_id=d.id AND m.from_us=0 ORDER BY m.sent_at DESC LIMIT 1) AS brand_at
    FROM deals d
    WHERE d.funnel_stage = 'pitching' AND d.state = 'open'
      AND d.ball_in_court = 'us'
      ${creatorFilter}`).all(...params);
  const extractDollar = txt => {
    if (!txt) return null;
    const matches = [...txt.matchAll(/\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)(?!\d)/g)]
      .map(m => Math.round(parseFloat(m[1].replace(/,/g,'')) * 100))
      .filter(c => c >= 10000 && c <= 5000000);
    return matches.length ? Math.max(...matches) : null;
  };
  for (const d of pitching) {
    const counterCents = extractDollar(d.brand_msg);
    const hasCounter = counterCents && d.fee_cents && counterCents !== d.fee_cents;
    const age = daysSince(d.brand_at);
    if (hasCounter) {
      const deltaPct = Math.round((counterCents - d.fee_cents) / d.fee_cents * 100);
      // Hard lowball (≤ -50%) → walk-away signal. Otherwise → counter.
      const walkAway = deltaPct <= -50;
      signals.push({
        kind: walkAway ? 'walk_away' : 'review_counter',
        deal_id: d.id, brand: d.brand, creator: d.creator_id,
        urgency: walkAway ? 40 : Math.min(55 + (age||0) * 3, 80),
        value_cents: d.fee_cents,
        reason: walkAway
          ? `Brand countered $${(counterCents/100).toLocaleString()} on our $${(d.fee_cents/100).toLocaleString()} (-${Math.abs(deltaPct)}%) — likely walk-away.`
          : `Brand countered $${(counterCents/100).toLocaleString()} (${deltaPct >= 0 ? '+' : ''}${deltaPct}%) — your move.`,
        suggested_action: walkAway ? 'walk_away' : 'review_counter',
      });
    } else if (d.ball_in_court === 'us' && age != null) {
      // Brand replied generically — still needs a reply
      signals.push({
        kind: 'cook_reply',
        deal_id: d.id, brand: d.brand, creator: d.creator_id,
        urgency: Math.min(45 + age * 4, 75),
        value_cents: d.fee_cents || 0,
        reason: `Brand replied ${age}d ago, your move — they're warm.`,
        suggested_action: 'cook_reply',
      });
    }
  }

  // ---- 3. Stale threads (3-14d silent on brand side) → nudge ----
  // Cap nudge candidates to highest-value 8 to keep plays list manageable
  const staleThreads = db.prepare(`
    SELECT d.id, d.brand, d.creator_id, d.fee_cents, d.raw_stage, d.funnel_stage,
           t.id AS thread_id, t.last_message_at, t.last_message_by,
           (SELECT MAX(sent_at) FROM messages m
            WHERE m.thread_id=t.id AND m.from_us=1) AS our_last_sent
    FROM threads t
    JOIN deals d ON d.id = t.deal_id
    WHERE d.state IN ('open','won')
      AND t.ball_in_court = 'them'
      AND datetime(t.last_message_at) < datetime('now', '-3 days')
      AND datetime(t.last_message_at) > datetime('now', '-14 days')
      AND d.funnel_stage IN ('pitching','in_works')
      ${creatorFilter}
    ORDER BY d.fee_cents DESC NULLS LAST LIMIT 8`).all(...params);
  for (const d of staleThreads) {
    const sinceUs = daysSince(d.our_last_sent);
    const sinceThem = daysSince(d.last_message_at);
    // Don't suggest a nudge if we ourselves just sent one in the last 3 days
    if (sinceUs != null && sinceUs < 3) continue;
    signals.push({
      kind: 'cook_nudge',
      deal_id: d.id, brand: d.brand, creator: d.creator_id,
      urgency: Math.min(35 + sinceThem * 3, 65),
      value_cents: d.fee_cents || 0,
      reason: `Brand quiet ${sinceThem}d — time for a polite nudge${d.fee_cents ? ` on $${(d.fee_cents/100).toLocaleString()}` : ''}.`,
      suggested_action: 'cook_nudge',
    });
  }

  // ---- 4. Payments overdue ----
  // Won/in-works deals where posting + payment_terms_days < today, no paid_cents
  const payments = db.prepare(`
    SELECT d.id, d.brand, d.creator_id, d.fee_cents, d.posting_date,
           COALESCE(d.payment_terms_days, 30) AS net_days,
           d.paid_cents
    FROM deals d
    WHERE d.state = 'won'
      AND d.posting_date IS NOT NULL
      AND d.fee_cents IS NOT NULL
      AND (d.paid_cents IS NULL OR d.paid_cents < d.fee_cents)
      ${creatorFilter}`).all(...params);
  for (const d of payments) {
    const dueDate = new Date(d.posting_date);
    dueDate.setDate(dueDate.getDate() + d.net_days);
    const overdueDays = Math.floor((Date.now() - dueDate.getTime()) / DAY);
    if (overdueDays < -7) continue;  // not due yet
    if (overdueDays < 0) {
      signals.push({
        kind: 'invoice_soon',
        deal_id: d.id, brand: d.brand, creator: d.creator_id,
        urgency: 40,
        value_cents: d.fee_cents,
        reason: `Payment due in ${Math.abs(overdueDays)}d ($${(d.fee_cents/100).toLocaleString()}, net ${d.net_days}) — send invoice now.`,
        suggested_action: 'send_invoice',
      });
    } else {
      signals.push({
        kind: 'chase_payment',
        deal_id: d.id, brand: d.brand, creator: d.creator_id,
        urgency: Math.min(70 + overdueDays * 2, 95),
        value_cents: d.fee_cents,
        reason: `Payment ${overdueDays}d overdue — chase $${(d.fee_cents/100).toLocaleString()}.`,
        suggested_action: 'chase_payment',
      });
    }
  }

  // ---- 5. New leads / unmatched envelopes — ONLY when no creator filter ----
  // When Riley is on Cooper or Charlie tab, he wants HIS stuff only. Unmatched
  // contracts/envelopes have no creator yet, so they belong in the New Leads
  // tray (which always shows them) — not in this creator-specific brain.
  if (!creator) {
    const leads = db.prepare(`
      SELECT id, fee_cents, created_at, extracted
      FROM contracts WHERE deal_id IS NULL AND dismissed_at IS NULL
        AND fee_cents >= 30000
        AND datetime(created_at) >= datetime('now','-14 days')`).all();
    for (const c of leads) {
      let brand = '(unknown brand)';
      try { brand = JSON.parse(c.extracted || '{}').brand_party || brand; } catch {}
      signals.push({
        kind: 'claim_lead',
        deal_id: null, brand, creator: null,
        urgency: 65,
        value_cents: c.fee_cents,
        reason: `Unmatched contract sitting — $${(c.fee_cents/100).toLocaleString()} waiting to be claimed.`,
        suggested_action: 'claim_lead',
        contract_id: c.id,
      });
    }

    const esignPending = db.prepare(`
      SELECT id, title, body, created_at FROM notifications
      WHERE kind = 'esign_pending' AND deal_id IS NULL
        AND dismissed_at IS NULL AND undone_at IS NULL
        AND datetime(created_at) >= datetime('now', '-7 days')`).all();
    for (const n of esignPending) {
      signals.push({
        kind: 'esign_pending',
        deal_id: null, brand: (n.title || '').replace(/^🖊️\s*/, '').replace(/\s+sent.*/, '').trim(),
        creator: null,
        urgency: 70,
        value_cents: 0,
        reason: `DocuSign envelope from this brand — open Gmail to sign.`,
        suggested_action: 'review_esign',
      });
    }
  }

  // ---- Authority-tier weighting ----
  // Pull the latest brand-msg classification for each deal_id. The Gmail
  // ingest already classifies inbound messages — we just read the cached tag.
  const dealIds = signals.map(s => s.deal_id).filter(Boolean);
  if (dealIds.length) {
    const classMap = {};
    try {
      const rows = db.prepare(`
        SELECT t.deal_id, m.classification
        FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE t.deal_id IN (${dealIds.map(()=>'?').join(',')})
          AND m.from_us = 0
          AND m.classification IS NOT NULL
        ORDER BY m.sent_at DESC`).all(...dealIds);
      for (const r of rows) {
        if (classMap[r.deal_id]) continue;
        try { classMap[r.deal_id] = JSON.parse(r.classification); } catch {}
      }
    } catch {}
    for (const s of signals) {
      const cls = s.deal_id ? classMap[s.deal_id] : null;
      if (cls) {
        s.authority = cls.authority;
        s.action_type = cls.action_type;
      }
    }
  }

  // ---- Final ranking with authority multiplier ----
  // contract_obligation = 3x, negotiated_term = 1.5x, soft_request = 0.3x, fyi = 0 (filtered)
  const authorityMult = {
    contract_obligation: 3.0,
    negotiated_term: 1.5,
    soft_request: 0.3,
    fyi: 0,
  };
  // Separate FYI items from the main play list — they go in a side tray.
  const fyiItems = [];
  const mainSignals = [];
  for (const s of signals) {
    const mult = s.authority ? (authorityMult[s.authority] ?? 1.0) : 1.0;
    if (s.authority === 'fyi') {
      fyiItems.push(s);
      continue;
    }
    const v = Math.log10((s.value_cents || 0) / 100 + 1);
    s._score = s.urgency * mult * (1 + v * 0.3);
    mainSignals.push(s);
  }
  mainSignals.sort((a, b) => b._score - a._score);
  for (const s of mainSignals) delete s._score;
  // Attach fyi items as a side property so the API can return them separately
  mainSignals.fyi = fyiItems;
  return mainSignals;
}

// Optional AI pass: re-rank + rewrite reasons in Riley's voice.
// Falls back to rule-based ranking if AI is off or fails.
export async function rankWithAI({ signals, apiKey, creator }) {
  if (!apiKey || !signals.length) return signals;
  // Trim to top 12 for cost
  const top = signals.slice(0, 12);
  const sys = `You're Riley's chief of staff for his influencer agency Triibe Talents. You read a list of action signals and output the TOP 5-7 plays for today, ranked by urgency × dollar value × winnability.

OUTPUT FORMAT: JSON array of objects with keys:
  {kind, deal_id, brand, creator, urgency (1-100), value_cents, reason, suggested_action}
Where reason is a punchy 1-sentence Riley-voice ("Sintra contract 2d unsigned — sign + return to lock $1.8k.") not a vague summary.

RULES:
- Lead with money on the table that can move TODAY (unsigned contracts > counter offers > overdue payments).
- Walk-away signals (brand at -50% of ask) should appear but lower priority than active money.
- Don't list a nudge unless it's a 4d+ silent thread on a deal >$1k.
- Don't include >7 plays. Quality over quantity.
- NEVER make up numbers — only use values in the signal list.`;
  const user = `${creator ? creator.toUpperCase() + "'S " : ''}SIGNALS (raw, ranked by simple rule):
${JSON.stringify(top, null, 2)}

Output the top 5-7 plays as JSON array. Tighten reasons. Re-order if you spot a better priority.`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST', headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body: JSON.stringify({
        model: 'gpt-4o', temperature: 0.3, max_tokens: 1200,
        response_format: { type: 'json_object' },
        messages: [
          {role:'system', content: sys},
          {role:'user',   content: user + "\n\nWrap your array in {\"plays\": [...]}."},
        ],
      }),
    });
    const data = await r.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    const plays = Array.isArray(parsed.plays) ? parsed.plays : Array.isArray(parsed) ? parsed : [];
    if (!plays.length) return signals.slice(0, 7);
    return plays.slice(0, 7).map(p => ({
      ...top.find(s => s.deal_id === p.deal_id && s.kind === p.kind) || {},  // keep contract_id, etc.
      ...p,  // AI-refined fields win
    }));
  } catch (e) {
    console.warn('[plays] AI rank failed:', e.message);
    return signals.slice(0, 7);
  }
}
