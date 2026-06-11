// this_week.js — builds the concrete deliverables checklist for a creator's
// booked deals: sign contracts, deliver scripts/assets, post by date, send
// invoices. Reads deal state + contract obligations + posting/payment dates.

const DAY = 86400000;

function daysFromNow(iso) {
  if (!iso) return null;
  return Math.round((new Date(iso).getTime() - Date.now()) / DAY);
}
function dateLabel(daysOut, iso) {
  if (daysOut == null) return '';
  if (daysOut < 0) return `${Math.abs(daysOut)}d overdue`;
  if (daysOut === 0) return 'today';
  if (daysOut === 1) return 'tomorrow';
  if (daysOut <= 7) return `in ${daysOut}d`;
  if (!iso) return `in ${daysOut}d`;
  return new Date(iso).toLocaleDateString([], { month:'short', day:'numeric' });
}
function urgencyTier(daysOut) {
  if (daysOut == null) return 'green';
  if (daysOut < 0) return 'red';        // overdue
  if (daysOut <= 2) return 'red';       // urgent
  if (daysOut <= 7) return 'amber';     // this week
  return 'green';                        // later
}

/**
 * Build "this week" actions for a creator's active deals.
 * Returns: { deals: [{ deal_id, brand, fee_cents, raw_stage, actions: [...] }] }
 * Each action includes a `completed` flag pulled from action_completions table.
 *
 * Uses AI extractor (reads thread + obligations) when API key available;
 * falls back to heuristic rules when not.
 */
export async function buildThisWeek({ db, creator, apiKey = null, stripQuotedReply = null }) {
  if (!creator) return { deals: [] };
  // Pull all booked / in-works deals for this creator.
  // EXCLUDE funnel_stage='completed' — those live in the Completed tab.
  const deals = db.prepare(`
    SELECT * FROM deals
    WHERE creator_id = ?
      AND funnel_stage != 'completed'
      AND (state IN ('won') OR (state='open' AND funnel_stage IN ('in_works','active','pitching')))
      AND (managed_by IS NULL OR managed_by = 'riley')
    ORDER BY
      CASE
        WHEN posting_date IS NOT NULL THEN posting_date
        ELSE date(last_activity_at, '+14 days')
      END ASC`).all(creator);

  // Pre-fetch completed actions for these deals so we can mark them ✓
  const dealIds = deals.map(d => d.id);
  const completed = dealIds.length
    ? db.prepare(`SELECT deal_id, action_kind, completed_at FROM action_completions
        WHERE deal_id IN (${dealIds.map(()=>'?').join(',')})`).all(...dealIds)
    : [];
  const completedMap = {};
  for (const c of completed) completedMap[`${c.deal_id}:${c.action_kind}`] = c.completed_at;

  const out = [];

  // Optional AI extractor — preferred path when available
  let extractActionsForDeal = null;
  if (apiKey) {
    try {
      const mod = await import('./extract_actions.js');
      extractActionsForDeal = mod.extractActionsForDeal;
    } catch {}
  }

  for (const d of deals) {
    let actions = [];
    let aiSucceeded = false;

    // ---- TRY AI extractor first (reads actual thread context) ----
    let aiKeyDates = {};
    if (extractActionsForDeal) {
      try {
        const r = await extractActionsForDeal({ db, deal: d, apiKey, stripQuotedReply });
        if (Array.isArray(r.actions)) {
          actions = r.actions.map(a => ({
            kind: a.kind || 'other',
            label: a.label || '',
            detail: a.detail || a.evidence || '',
            tier: a.tier || 'green',
            date_label: a.date_label || '',
            days_out: null,
          }));
          aiKeyDates = r.key_dates || {};
          aiSucceeded = true;
        }
      } catch {}
    }

    // ---- Fallback: heuristic rules (when no AI or AI failed) ----
    if (!aiSucceeded) {

    // ---- 1. Contract not signed yet ----
    if (d.raw_stage === 'contract_received') {
      const ageDays = d.last_activity_at ? Math.floor((Date.now() - new Date(d.last_activity_at).getTime()) / DAY) : 0;
      actions.push({
        kind: 'sign_contract',
        label: 'Sign contract',
        detail: ageDays > 0 ? `Contract arrived ${ageDays}d ago — sign + return` : 'Contract just arrived — sign + return',
        days_out: -ageDays,
        tier: urgencyTier(-ageDays),
        date_label: ageDays > 0 ? `${ageDays}d unsigned` : 'today',
      });
    }

    // ---- 2. Posting date this week or next 2 weeks ----
    if (d.posting_date) {
      const dOut = daysFromNow(d.posting_date);
      if (dOut != null && dOut > -3 && dOut <= 21) {
        actions.push({
          kind: 'post',
          label: `Post ${d.deliverable_summary || '1 piece'}`,
          detail: d.usage_rights ? `Usage: ${(d.usage_rights || '').slice(0, 50)}` : null,
          days_out: dOut,
          tier: urgencyTier(dOut),
          date_label: dateLabel(dOut, d.posting_date),
        });
      }
    }

    // ---- 3. Asset delivery — only AFTER contract is signed.
    //   Lead time: 4 days before post (realistic — most brands need 3-5d review).
    //   Hint from ai_summary / next_action_detail when available
    //   (e.g. "script by Jun 13-14" → use that explicit date).
    if (d.posting_date && d.state === 'won' && (d.funnel_stage === 'in_works' || d.funnel_stage === 'active')) {
      const dOut = daysFromNow(d.posting_date);
      // Try to pull an explicit deliver date from the summary/note text
      const blob = `${d.ai_summary || ''} ${d.next_action_detail || ''}`;
      let explicitDelivDays = null;
      const mISO = blob.match(/script\s+(?:over\s+)?(?:to\s+\w+\s+)?(?:by\s+)?(\d{4}-\d{2}-\d{2})/i);
      if (mISO) explicitDelivDays = daysFromNow(mISO[1]);
      // Also catch "by Jun 13" style
      if (explicitDelivDays == null) {
        const mDate = blob.match(/script[^.]{0,40}\b(?:by|due)\s+(?:~\s*)?(\w+\s+\d{1,2})(?:-\d{1,2})?/i);
        if (mDate) {
          const candidate = new Date(`${mDate[1]} ${new Date().getFullYear()}`);
          if (!isNaN(candidate.getTime())) explicitDelivDays = Math.round((candidate.getTime() - Date.now()) / DAY);
        }
      }
      const deliverDate = explicitDelivDays != null ? explicitDelivDays
                        : (dOut != null ? dOut - 4 : null);  // 4-day default lead time
      if (deliverDate != null && deliverDate > -7 && deliverDate <= 21) {
        actions.push({
          kind: 'deliver_asset',
          label: 'Deliver script/asset to brand',
          detail: explicitDelivDays != null
            ? 'Per brand timeline'
            : 'Send a few days before post date for review',
          days_out: deliverDate,
          tier: urgencyTier(deliverDate),
          date_label: dateLabel(deliverDate, null),
        });
      }
    }
    // ---- 3b. PREP asset (script/concept) — when contract not yet signed.
    //   Riley shouldn't deliver before sign, but can start writing.
    if (d.posting_date && d.raw_stage === 'contract_received') {
      const dOut = daysFromNow(d.posting_date);
      if (dOut != null && dOut <= 14 && dOut > 0) {
        actions.push({
          kind: 'prep_asset',
          label: 'Prep script/concept (hold until signed)',
          detail: 'Draft the asset so it\'s ready the moment contract is countersigned',
          days_out: dOut - 4,
          tier: 'green',
          date_label: `after sign`,
        });
      }
    }

    // ---- 4. Payment due (post + payment_terms_days) ----
    if (d.posting_date && d.fee_cents && d.state === 'won') {
      const netDays = d.payment_terms_days || 30;
      const dueDate = new Date(d.posting_date);
      dueDate.setDate(dueDate.getDate() + netDays);
      const dOut = Math.round((dueDate.getTime() - Date.now()) / DAY);
      if (dOut > -7 && dOut <= 30) {
        const paid = (d.paid_cents || 0) >= d.fee_cents;
        if (!paid) {
          actions.push({
            kind: dOut < 0 ? 'chase_payment' : 'send_invoice',
            label: dOut < 0 ? 'Chase payment' : 'Send invoice',
            detail: `$${(d.fee_cents/100).toLocaleString()} due ${dateLabel(dOut, dueDate.toISOString())} (net ${netDays})`,
            days_out: dOut,
            tier: urgencyTier(dOut),
            date_label: dateLabel(dOut, dueDate.toISOString()),
          });
        }
      }
    }

    // ---- 5. Confirm scope (pitching stage with terms_agreed_pending_client) ----
    if (d.raw_stage === 'terms_agreed_pending_client' || d.raw_stage === 'terms_agreed') {
      actions.push({
        kind: 'confirm_scope',
        label: 'Confirm scope with brand',
        detail: 'Lock the deliverables + dates so they can send the contract',
        days_out: 5,
        tier: 'amber',
        date_label: 'this week',
      });
    }

    // ---- 6. Brand silent / nudge needed (waiting 7+ days) ----
    if (d.ball_in_court === 'them' && d.funnel_stage === 'in_works') {
      const ageDays = d.last_activity_at ? Math.floor((Date.now() - new Date(d.last_activity_at).getTime()) / DAY) : 0;
      if (ageDays >= 7) {
        actions.push({
          kind: 'nudge',
          label: 'Nudge brand',
          detail: `Quiet for ${ageDays}d — send a polite check-in`,
          days_out: 0,
          tier: 'amber',
          date_label: `${ageDays}d quiet`,
        });
      }
    }

    }  // end heuristic fallback block

    if (actions.length) {
      // Mark completed actions + sort: incomplete-by-tier first, completed at bottom
      for (const a of actions) {
        const completedAt = completedMap[`${d.id}:${a.kind}`];
        a.completed = !!completedAt;
        a.completed_at = completedAt || null;
      }
      const tierOrder = { red: 0, amber: 1, green: 2 };
      actions.sort((a, b) => {
        // Completed sinks to the bottom
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        if (tierOrder[a.tier] !== tierOrder[b.tier]) return tierOrder[a.tier] - tierOrder[b.tier];
        return (a.days_out ?? 99) - (b.days_out ?? 99);
      });
      const openActions = actions.filter(a => !a.completed);
      // Build key_dates from AI + fallback to deal columns
      const key_dates = {
        post:        aiKeyDates.post        || d.posting_date || null,
        script_due:  aiKeyDates.script_due  || null,
        delivery:    aiKeyDates.delivery    || null,
        payment_due: aiKeyDates.payment_due || (d.posting_date && d.payment_terms_days
                       ? (() => {
                           const dt = new Date(d.posting_date);
                           dt.setDate(dt.getDate() + d.payment_terms_days);
                           return `${dt.toISOString().slice(0,10)} (net ${d.payment_terms_days})`;
                         })()
                       : null),
        sign_by:     aiKeyDates.sign_by || null,
      };
      out.push({
        deal_id: d.id,
        brand: d.brand,
        fee_cents: d.fee_cents,
        raw_stage: d.raw_stage,
        funnel_stage: d.funnel_stage,
        state: d.state,
        posting_date: d.posting_date,
        key_dates,
        actions,
        open_count: openActions.length,
        completed_count: actions.length - openActions.length,
        next_action_at: openActions[0]?.days_out ?? 999,
      });
    }
  }

  // Sort deals: any with open actions first (by urgency), then fully complete
  out.sort((a, b) => {
    if ((a.open_count > 0) !== (b.open_count > 0)) return a.open_count > 0 ? -1 : 1;
    return (a.next_action_at ?? 999) - (b.next_action_at ?? 999);
  });

  // Split into CONFIRMED deals (deliverables owed) vs PENDING (still negotiating)
  // Confirmed = signed contract OR fully-agreed terms with creator obligated to deliver.
  // Pending = "Close these deals" — active negotiation where brand has put a real
  //   number on the table OR sent a substantive reply in the last 7 days needing
  //   our response (NOT silent rate-pitched — those are in Follow Ups).
  const CONFIRMED_RAW_STAGES = new Set([
    'signed', 'contract_signed', 'contract_received',
    'in_revision', 'in_production', 'confirmed', 'terms_agreed',
  ]);
  const confirmed = [];
  const pending = [];
  for (const d of out) {
    const isConfirmed = d.state === 'won' || CONFIRMED_RAW_STAGES.has(d.raw_stage);
    if (isConfirmed) { confirmed.push(d); continue; }
    // Pending = brand has actively engaged. Check whether the brand recently
    // replied (within 7 days) AND it's not "rate_sent waiting" only.
    const dealRow = db.prepare(`SELECT ball_in_court, last_activity_at, raw_stage FROM deals WHERE id=?`).get(d.deal_id);
    const recentBrandActivity = dealRow?.last_activity_at
      && (Date.now() - new Date(dealRow.last_activity_at).getTime()) / 86400000 < 7;
    const isActiveNeg = dealRow?.ball_in_court === 'us' && recentBrandActivity;
    const isTermsAgreed = dealRow?.raw_stage === 'terms_agreed_pending_client';
    if (isActiveNeg || isTermsAgreed) {
      pending.push(d);
    }
    // else: silent rate_sent → goes to Follow Ups tab (separate /api/follow-ups endpoint)
  }
  return { deals: confirmed, pending };
}

/** Mark an action as completed */
export function completeAction({ db, deal_id, action_kind }) {
  db.prepare(`INSERT OR REPLACE INTO action_completions (deal_id, action_kind, completed_at)
    VALUES (?, ?, datetime('now'))`).run(deal_id, action_kind);
  // Auto-promote to Completed when ALL these are true:
  //   1. Deal is won/signed (state=won)
  //   2. The invoice action has been issued (kind=send_invoice OR chase_payment is done)
  //   3. The brand has confirmed payment-in-flight via an external platform
  //      (signal lives in the latest brand message classification — payment_chase
  //      with platform keywords like Lumanu/Wise/Stripe). This means the work
  //      is done + invoice issued + money routing → "wrapped, awaiting payout".
  // Conservative: only if invoice was the action just completed.
  if (['send_invoice','chase_payment'].includes(action_kind)) {
    try {
      const deal = db.prepare(`SELECT id, state, funnel_stage, raw_stage FROM deals WHERE id=?`).get(deal_id);
      if (deal && deal.state === 'won' && deal.funnel_stage !== 'completed') {
        // Check for payment-in-flight signal in latest brand message
        const latestCls = db.prepare(`
          SELECT m.classification, m.body FROM messages m
          JOIN threads t ON t.id = m.thread_id
          WHERE t.deal_id = ? AND m.from_us = 0
          ORDER BY m.sent_at DESC LIMIT 1`).get(deal_id);
        let inFlight = false;
        if (latestCls?.classification) {
          try {
            const cls = JSON.parse(latestCls.classification);
            const body = (latestCls.body || '').toLowerCase();
            inFlight = cls.action_type === 'payment_chase'
              && /(lumanu|wise|payoneer|stripe|tipalti|paid via|invoice (sent|processed|received))/i.test(body);
          } catch {}
        }
        if (inFlight) {
          db.prepare(`UPDATE deals SET funnel_stage='completed', raw_stage='completed',
            updated_at=datetime('now') WHERE id=?`).run(deal_id);
        }
      }
    } catch {}
  }
  return { ok: true };
}

/** Un-mark an action (untick) */
export function uncompleteAction({ db, deal_id, action_kind }) {
  db.prepare(`DELETE FROM action_completions WHERE deal_id=? AND action_kind=?`)
    .run(deal_id, action_kind);
  return { ok: true };
}
