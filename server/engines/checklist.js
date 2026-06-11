// Deal Completeness engine — for every deal, produces a checklist of the
// 10 milestones from brief -> posted -> paid -> usage-expiry, with per-item
// status inferred from flags + extra fields + payments + activity.
//
// Status values:
//   done    — evidence confirms it (flag match, payment row, posted_url, etc.)
//   missing — actively owed by US (e.g. "payee_redirect_pending" means
//             brand is waiting on us to send payment info)
//   blocked — owed by THEM (waiting on brand to send brief/contract)
//   issue   — actively flagged as a problem (term mismatch, blank field)
//   na      — not applicable yet at this stage
//   unknown — no signal either way
//
// The engine is deliberately pattern-based on flags/notes so it works from
// the existing migrated data without needing Gmail/contract ingest.

// Pattern -> milestone+status. Hand-curated from Riley's actual flag vocabulary.
const RULES = [
  // brief received
  { item: 'brief',          status: 'done',    re: /brief.received|brief_received|brief.*in/i },
  { item: 'brief',          status: 'missing', re: /no.brief|brief.requested|asked.for.brief|awaiting.brief/i },

  // terms agreed
  { item: 'terms_agreed',   status: 'done',    re: /terms.accepted|terms_agreed|verbal.yes|fee.locked|rate.confirmed/i },
  { item: 'terms_agreed',   status: 'issue',   re: /below.floor|under_floor|negotiating.budget|passed_budget/i },

  // contract received
  { item: 'contract_received', status: 'done', re: /contract.received|contract_received|contract.in|contract.filled|contract.reviewed|contract.final/i },
  { item: 'contract_received', status: 'blocked', re: /awaiting.contract|contract.requested|asked.for.contract|no.contract.yet/i },

  // contract matches agreed terms
  { item: 'contract_matches', status: 'issue', re: /term_clause_post_mismatch|terms_mismatch|contract.differs|date_mismatch|fee_field_blank|usage_cap_field_blank|blank_fields_verify|contract.error|wrong.fee/i },
  { item: 'contract_matches', status: 'done',  re: /contract_reviewed|contract.ok|contract.clean|terms.match/i },

  // contract signed
  { item: 'signed',         status: 'done',    re: /contract_executed_both|contract_fully_signed|signed_by_both|fully.signed|contract.signed.both/i },
  { item: 'signed',         status: 'missing', re: /sig_pending_riley|signed_by_triibe.*pending|riley.to.sign|cooper.to.sign|charlie.to.sign|awaiting.our.signature/i },
  { item: 'signed',         status: 'blocked', re: /awaiting.brand.sig|brand.to.sign|countersign.pending/i },

  // payment info (W-9 / banking / payee) sent
  { item: 'payment_info',   status: 'done',    re: /payee_triibe_set|payee.confirmed|w9.sent|banking.sent|payment.info.sent/i },
  { item: 'payment_info',   status: 'missing', re: /payee_redirect_pending|w9.requested|banking.requested|payment.info.requested|payee.pending/i },

  // invoice sent
  { item: 'invoice_sent',   status: 'done',    re: /invoice.sent|invoice.issued|invoice_sent/i },
  { item: 'invoice_sent',   status: 'missing', re: /invoice.due|invoice.todo|need.to.invoice/i },

  // content approved
  { item: 'content_approved', status: 'done', re: /content.approved|approval.received|approved_by_brand|brand.confirmed.receipt|brand_confirmed_receipt/i },
  { item: 'content_approved', status: 'blocked', re: /awaiting.approval|approval.pending|in.revision|in_revision/i },

  // posted
  { item: 'posted',         status: 'done',    re: /posted|posted_jun|published|live_on_ig|live_on_tt/i },
  { item: 'posted',         status: 'missing', re: /post.due|posting.this.week|to.post/i },

  // usage rights expiry tracked
  { item: 'usage_tracked',  status: 'issue',   re: /perpetual|no.usage.cap|usage.unlimited/i },
];

// Items in display order with friendly labels.
export const ITEMS = [
  { key: 'brief',             label: 'Brief received' },
  { key: 'terms_agreed',      label: 'Terms agreed (fee, deliverable, usage)' },
  { key: 'contract_received', label: 'Contract received' },
  { key: 'contract_matches',  label: 'Contract matches agreed terms' },
  { key: 'signed',            label: 'Contract signed by both' },
  { key: 'payment_info',      label: 'Payment info sent (W-9 / banking)' },
  { key: 'invoice_sent',      label: 'Invoice sent' },
  { key: 'invoice_paid',      label: 'Payment received' },
  { key: 'content_approved',  label: 'Content approved by brand' },
  { key: 'posted',            label: 'Posted' },
  { key: 'usage_tracked',     label: 'Usage rights expiry tracked' },
];

const SEVERITY = { issue: 3, missing: 2, blocked: 1, done: 0, na: 0, unknown: 0 };

// Compute the checklist for one deal. `dealRow` is the SQLite row; payments
// array contains payment rows for this deal.
export function checklistForDeal(deal, payments = []) {
  const flags = (deal.flags || []);
  const noteBlob = [
    flags.join(' '),
    deal.next_action || '',
    deal.next_action_detail || '',
    JSON.stringify(deal.extra || {}),
  ].join(' ');

  // Start every item at "unknown"; rules upgrade by severity.
  const result = Object.fromEntries(ITEMS.map(i => [i.key, { status: 'unknown', evidence: null }]));

  for (const rule of RULES) {
    const m = noteBlob.match(rule.re);
    if (m) {
      const cur = result[rule.item];
      // higher severity wins (issue > missing > blocked > done)
      if (!cur || SEVERITY[rule.status] >= SEVERITY[cur.status])
        result[rule.item] = { status: rule.status, evidence: m[0] };
    }
  }

  // ---- structural inferences from typed columns ----
  // brief: if we have fee + funnel_stage advanced, we know the terms => brief is done.
  // (Don't ask "send me the brief" on a deal where a contract is already in flight.)
  if (deal.fee_cents
      && ['in_works','active','completed'].includes(deal.funnel_stage)
      && result.brief.status !== 'done')
    result.brief = { status: 'done', evidence: 'inferred: fee + advanced stage' };

  // terms_agreed: if fee_cents is set
  if (deal.fee_cents && result.terms_agreed.status === 'unknown')
    result.terms_agreed = { status: 'done', evidence: `fee_cents=${deal.fee_cents}` };

  // contract_received: if raw_stage explicitly says contract is in our hands or beyond,
  // OVERRIDE any "blocked" guess from flag regex. The raw_stage is authoritative.
  if (['contract_received','contract_signed','signed','in_revision','in_production','confirmed','terms_agreed_pending_client'].includes(deal.raw_stage))
    result.contract_received = { status: 'done', evidence: `raw_stage=${deal.raw_stage}` };

  // signed: if raw_stage is signed/contract_signed OR state=won, override.
  if (['signed','contract_signed'].includes(deal.raw_stage) || deal.state === 'won')
    result.signed = { status: 'done', evidence: `raw_stage=${deal.raw_stage}, state=${deal.state}` };

  // signed: contract_signed/signed funnel stage = won state
  if (deal.state === 'won' && result.signed.status === 'unknown')
    result.signed = { status: 'done', evidence: `state=won` };

  // invoice_paid: any payment row with status=paid
  const paid = payments.find(p => p.status === 'paid');
  if (paid) result.invoice_paid = { status: 'done', evidence: `paid ${paid.paid_at || ''}` };
  else if (deal.fee_status === 'invoiced') result.invoice_paid = { status: 'missing', evidence: 'invoice outstanding' };
  else result.invoice_paid = result.invoice_paid.status === 'unknown'
    ? { status: 'na', evidence: 'pre-invoice' } : result.invoice_paid;

  // posted: posting_date in the past + posted_url in extra
  const today = new Date().toISOString().slice(0,10);
  if (deal.extra?.posted_url) result.posted = { status: 'done', evidence: deal.extra.posted_url };
  else if (deal.posting_date && deal.posting_date < today && result.posted.status === 'unknown')
    result.posted = { status: 'missing', evidence: `posting_date ${deal.posting_date} has passed` };

  // usage_tracked: usage_rights set and not perpetual
  if (deal.usage_rights && !/perpetual/i.test(deal.usage_rights || '')
      && result.usage_tracked.status === 'unknown')
    result.usage_tracked = { status: 'done', evidence: deal.usage_rights.slice(0, 40) };

  // stage-aware: items downstream of current stage are 'na'
  const order = ['cold','conversation','pitching','in_works','active','completed'];
  const stageIdx = order.indexOf(deal.funnel_stage);
  const minStage = {
    contract_received: 'pitching', contract_matches: 'pitching', signed: 'pitching',
    payment_info: 'in_works', invoice_sent: 'in_works', invoice_paid: 'in_works',
    content_approved: 'in_works', posted: 'in_works', usage_tracked: 'active',
  };
  for (const [k, st] of Object.entries(minStage)) {
    if (stageIdx < order.indexOf(st) && result[k].status === 'unknown')
      result[k] = { status: 'na', evidence: `pre-${st}` };
  }

  // ---- compute summary ----
  const items = ITEMS.map(i => ({ ...i, ...result[i.key] }));
  const open = items.filter(i => i.status === 'issue' || i.status === 'missing');
  const blocked = items.filter(i => i.status === 'blocked');
  const done = items.filter(i => i.status === 'done').length;
  const total = items.filter(i => i.status !== 'na').length;

  return {
    deal_id: deal.id,
    items,
    summary: {
      done, total,
      pct: total ? Math.round(100 * done / total) : 0,
      open_count: open.length,
      blocked_count: blocked.length,
      next_action: open[0] ? `${open[0].label} (${open[0].status})` : (blocked[0] ? `Waiting on brand: ${blocked[0].label}` : 'all clear')
    },
    open, blocked,
  };
}

// Auto-pick the right draft mode from the deal's current state + checklist.
// Returns: 'counter' | 'ask_brief' | 'chase_contract' | 'payment_followup' |
//          'request_signature' | 'gentle_nudge' | 'channel_switch'
export function pickDraftMode(deal, checklist) {
  const open = checklist.open || [];
  const byKey = Object.fromEntries((checklist.items || []).map(i => [i.key, i.status]));
  const ball = deal.ball_in_court;
  const daysIdle = deal.days_idle || 0;

  // 1. Brief missing (highest priority — can't quote without it)
  if (byKey.brief === 'missing') return 'ask_brief';

  // 2. Contract issues — actual or pending mismatch
  if (byKey.contract_matches === 'issue') return 'flag_contract_mismatch';
  if (byKey.contract_received === 'blocked') return 'chase_contract';

  // 3. Signature pending on our side, OR contract just arrived and we owe ack.
  //    If the brand sent a contract/DocuSign and ball is in our court, we should
  //    acknowledge progress + commit to next step — NOT re-ask for a brief or quote.
  if (byKey.signed === 'missing') return 'request_signature';
  if (byKey.contract_received === 'done' && ball === 'us'
      && deal.funnel_stage === 'in_works')
    return 'acknowledge_progress';

  // 4. Payment info / W-9 owed by us
  if (byKey.payment_info === 'missing') return 'payment_followup';

  // 5. Invoice/payment chase
  if (byKey.invoice_paid === 'missing') return 'chase_payment';

  // 6. Stage-based fallback
  if (deal.funnel_stage === 'pitching' && ball === 'us') return 'counter';
  if (ball === 'them' && daysIdle >= 5) return 'gentle_nudge';
  if (deal.primary_channel === 'email' && deal.funnel_stage === 'pitching')
    return 'channel_switch';

  return 'counter'; // default
}

// Build the global "anti-mistake" rollup: for every active deal, what do we owe?
export function antiMistakeReport(deals, paymentsByDeal = {}) {
  const buckets = {};
  for (const d of deals) {
    if (d.state !== 'open' && d.state !== 'won') continue;
    if (!['pitching','in_works','active'].includes(d.funnel_stage)) continue;
    const cl = checklistForDeal(d, paymentsByDeal[d.id] || []);
    for (const item of cl.open) {
      (buckets[item.key] ||= { label: item.label, deals: [] }).deals.push({
        deal_id: d.id, brand: d.brand, creator_id: d.creator_id,
        fee_cents: d.fee_cents, status: item.status, evidence: item.evidence
      });
    }
  }
  // sort buckets by # of deals owed (most pressing first)
  return Object.entries(buckets)
    .map(([key, b]) => ({ key, label: b.label, count: b.deals.length, deals: b.deals }))
    .sort((a, b) => b.count - a.count);
}
