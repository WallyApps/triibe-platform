// lifecycle.js — expand a deal into its FULL production lifecycle as a
// checklist. Replaces the old "1-2 next actions" view with the complete
// pipeline from script through paid, so Riley sees every step at a glance.
//
// Each step has a status auto-inferred from deal state:
//   - done    → strikethrough; already complete (we have evidence)
//   - active  → it's the current step Riley needs to push on
//   - waiting → ball on brand, we sent something, polling for reply
//   - todo    → future step, not started yet
//   - skipped → not applicable to this deal type
//
// State inference is intentionally conservative: when uncertain, default to
// "todo" so Riley sees the item rather than skipping it.

/**
 * Build the lifecycle steps for a single deal.
 *
 * @param {object} deal - merged deal row with last_outbound, unread_reply,
 *                       key_dates, posting_date, fee_cents, funnel_stage, etc.
 * @returns {Array<object>} array of step objects, each with:
 *   kind        - stable identifier (signed, script, draft, post, invoice, ...)
 *   label       - short, action-oriented title
 *   detail      - sub-line explaining context (often the current waiting state)
 *   tier        - red | amber | green (urgency hint)
 *   status      - done | active | waiting | todo | skipped
 *   date_label  - human-readable date if applicable
 *   completed   - true if step is fully done (used by checkbox UI)
 */
export function buildLifecycle(deal) {
  if (!deal) return [];
  // If we have a cached AI verdict, use it as the source of truth. The
  // keyword-based inference below stays as a fallback for deals that haven't
  // been audited yet (or where the AI returned 'unknown' for a step).
  let aiVerdict = null;
  if (deal.lifecycle_state) {
    try {
      aiVerdict = typeof deal.lifecycle_state === 'string'
        ? JSON.parse(deal.lifecycle_state)
        : deal.lifecycle_state;
    } catch {}
  }
  // Detect UGC / raw-footage deals (Mirage-style). These don't go through the
  // script → film → draft → post pipeline because the creator isn't posting
  // anything — they just deliver raw clips for the brand to edit. Detection:
  // deliverable mentions "raw", "UGC", "edit campaign", "AI Edit", OR there's
  // no posting_date AND state=won (= contract done, no post planned).
  const deliverable = String(deal.deliverable || deal.extra?.deliverable || '');
  const isUGC = /\bUGC\b|raw footage|raw content|raw clips|raw asset|edit campaign|AI Edit|no posting|deliver raw|raw_footage|raw-footage/i.test(deliverable)
             || (!deal.posting_date && !deal.key_dates?.post && deal.state === 'won');
  if (isUGC) {
    return buildUGCLifecycle(deal, aiVerdict);
  }
  const kd = deal.key_dates || {};
  const fee = deal.fee_cents ? '$' + (deal.fee_cents / 100).toLocaleString() : '';
  const out = deal.last_outbound || null;
  const unread = deal.unread_reply || null;
  const paymentRouting = deal.payment_in_flight || null;
  const stage = deal.funnel_stage || '';
  const raw = deal.raw_stage || '';
  const state = deal.state || 'open';
  // hasContract = there is REAL paper, not just verbal terms. The funnel_stage
  // is sometimes upstream-wrong (GoMarble shows in_works even though it's just
  // terms_agreed). So we require EITHER state=won OR raw_stage explicitly
  // mentions contract/signed/confirmed/received. "terms_agreed" alone is NOT
  // a contract — it falls through to the single "Negotiate" step.
  const hasContract = state === 'won'
                     || raw.includes('signed')
                     || raw.includes('contract')
                     || raw.includes('confirmed')
                     || raw === 'received';
  const isWon = state === 'won';
  const postingDate = deal.posting_date || kd.post;
  const postingDateLabel = kd.post || deal.posting_date || null;

  const steps = [];

  // ---- 0. Negotiation / contract phase (collapse to single item if done) ----
  if (hasContract || isWon) {
    steps.push({
      kind: 'terms_agreed',
      label: 'Terms agreed',
      detail: fee ? `Fee locked at ${fee}` : null,
      tier: 'green',
      status: 'done',
      completed: true,
    });
    steps.push({
      kind: 'contract_signed',
      label: 'Contract signed',
      detail: null,
      tier: 'green',
      status: hasContract ? 'done' : 'todo',
      completed: hasContract,
    });
  } else {
    // Pre-contract: show negotiation as the active step
    steps.push({
      kind: 'negotiate',
      label: 'Negotiate terms with brand',
      detail: unread ? `Brand replied — review their message` : (out ? `You ${out.kind?.toLowerCase()} ${formatAge(out.age_hours)}` : 'Send rate card + scope'),
      tier: unread ? 'red' : 'amber',
      status: unread ? 'active' : (out ? 'waiting' : 'active'),
      completed: false,
    });
    return steps;
  }

  // ---- 1. Script / concept phase ----
  const scriptDate = kd.script_due || (postingDate ? formatRelativeDate(postingDate, -7) : null);
  const scriptSent = out && /script|concept|outline/i.test(out.snippet || '');
  const scriptApproved = scriptSent && !unread;
  steps.push({
    kind: 'cook_script',
    label: 'Cook the script / concept',
    detail: scriptDate ? `Get it written by ${scriptDate}` : 'Write the script outline',
    tier: scriptApproved ? 'green' : 'amber',
    status: scriptApproved ? 'done' : 'active',
    date_label: scriptDate,
    completed: scriptApproved,
  });
  steps.push({
    kind: 'send_script',
    label: 'Send script to brand for review',
    detail: scriptApproved ? `Sent ${out?.age_hours ? formatAge(out.age_hours) : 'earlier'}` : 'Email or WA the script doc',
    tier: 'amber',
    status: scriptApproved ? 'done' : (scriptSent ? 'done' : 'todo'),
    completed: scriptApproved || scriptSent,
  });
  steps.push({
    kind: 'await_script_approval',
    label: 'Waiting for brand to approve script',
    detail: unread && scriptSent ? `📧 ${unread.sender} replied — read it` :
            scriptSent ? `Polling for reply, last sent ${formatAge(out?.age_hours)}` :
            'Pending',
    tier: (unread && scriptSent) ? 'red' : 'amber',
    status: !scriptSent ? 'todo' : (unread ? 'active' : 'waiting'),
    completed: false,
  });

  // ---- 2. Production phase ----
  const deliveryDate = kd.delivery || kd.draft_due || (postingDate ? formatRelativeDate(postingDate, -3) : null);
  const draftSent = out && /draft|edit|reel|video|preview/i.test(out.snippet || '');
  steps.push({
    kind: 'film_edit',
    label: 'Film + edit the Reel',
    detail: deliveryDate ? `Draft ready by ${deliveryDate}` : 'Shoot + post-production',
    tier: 'amber',
    status: draftSent ? 'done' : 'todo',
    date_label: deliveryDate,
    completed: draftSent,
  });
  steps.push({
    kind: 'send_draft',
    label: 'Send draft to brand for approval',
    detail: draftSent ? `Sent ${formatAge(out?.age_hours)}` : 'Upload draft + share link',
    tier: 'amber',
    status: draftSent ? 'done' : 'todo',
    completed: draftSent,
  });
  steps.push({
    kind: 'await_draft_approval',
    label: 'Waiting for brand to approve draft',
    detail: unread && draftSent ? `📧 ${unread.sender} replied — read it` :
            draftSent ? `Polling for reply` :
            'Pending',
    tier: (unread && draftSent) ? 'red' : 'amber',
    status: !draftSent ? 'todo' : (unread ? 'active' : 'waiting'),
    completed: false,
  });

  // ---- 3. Post phase ----
  if (postingDate) {
    const isPosted = postingDate && new Date(postingDate) < new Date();
    steps.push({
      kind: 'post_live',
      label: `Post live${postingDateLabel ? ` on ${formatDate(postingDateLabel)}` : ''}`,
      detail: isPosted ? 'Should be live — confirm with creator' : 'Schedule + publish',
      tier: isPosted ? 'red' : 'amber',
      status: isPosted ? 'active' : 'todo',
      date_label: postingDateLabel,
      completed: false,
    });
    steps.push({
      kind: 'analytics',
      label: 'Send analytics screenshots 3 days after post',
      detail: 'IG insights: reach, views, engagement',
      tier: 'green',
      status: 'todo',
      completed: false,
    });
  }

  // ---- 4. Money phase ----
  if (deal.fee_cents) {
    const paymentTermsDays = deal.payment_terms_days || 30;
    const paymentDueDate = kd.payment_due || null;
    steps.push({
      kind: 'send_invoice',
      label: `Issue invoice for ${fee}`,
      detail: paymentDueDate ? `Due ${paymentDueDate}` : `Net-${paymentTermsDays} from invoice date`,
      tier: 'green',
      status: paymentRouting ? 'done' : 'todo',
      date_label: paymentDueDate,
      completed: !!paymentRouting,
    });
    steps.push({
      kind: 'await_payment',
      label: paymentRouting ? `Payment routing via ${paymentRouting.platform}` : 'Waiting for payment',
      detail: paymentRouting ? `${paymentRouting.platform} processing — withdraw when it lands` :
              `Net-${paymentTermsDays} from invoice date`,
      tier: paymentRouting ? 'green' : 'amber',
      status: paymentRouting ? 'waiting' : 'todo',
      completed: false,
    });
  }

  // ---- Apply AI verdict overrides (if cached) ----
  // If the lifecycle_audit engine has run for this deal, prefer its verdict
  // for each step over the keyword-based inference above. This is what makes
  // the checklist accurate without Riley clicking anything — the AI looked
  // at the full conversation and decided what's actually done.
  if (aiVerdict) {
    for (const step of steps) {
      const v = aiVerdict[step.kind];
      if (!v || !v.status || v.status === 'unknown') continue;
      step.status = v.status;
      step.completed = v.status === 'done';
      // Use AI's evidence as the detail if it gave us something concrete
      if (v.evidence && v.evidence.length > 6) {
        step.detail = v.evidence;
      }
      // Tier hint: bump to red if active, amber if waiting
      if (v.status === 'active' && step.tier !== 'red') step.tier = 'red';
      if (v.status === 'done' && step.tier === 'red') step.tier = 'green';
      step.confidence = v.confidence;
    }
  }
  return steps;
}

// ---- UGC / raw-footage lifecycle ---------------------------------------------
// Short 5-step pipeline for deals where the talent delivers raw clips for the
// brand to edit themselves (Mirage, etc.). No script/film/draft/post — the
// brand handles all of that on their side.
function buildUGCLifecycle(deal, aiVerdict) {
  const fee = deal.fee_cents ? '$' + (deal.fee_cents / 100).toLocaleString() : '';
  const hasContract = ['in_works','signed','agreed','active','completed'].includes(deal.funnel_stage)
                     || (deal.raw_stage || '').includes('signed')
                     || (deal.raw_stage || '').includes('contract');
  const paymentRouting = deal.payment_in_flight || null;
  const out = deal.last_outbound || null;
  // Inference: "deliver raw" is done if Riley has sent a Google Drive / WeTransfer
  // / Dropbox link to the brand (common pattern for raw delivery)
  const deliverySent = out && /drive\.google|wetransfer|dropbox|raw|footage|delivered|here is the (content|raw|footage)|here.s the raw/i.test(out.snippet || '');

  const steps = [
    {
      kind: 'terms_agreed',
      label: 'Terms agreed',
      detail: fee ? `Fee locked at ${fee}` : 'Scope + fee confirmed',
      tier: 'green',
      status: 'done',
      completed: true,
    },
    {
      kind: 'contract_signed',
      label: 'Contract signed',
      detail: null,
      tier: 'green',
      status: hasContract ? 'done' : 'todo',
      completed: hasContract,
    },
    {
      kind: 'deliver_raw',
      label: 'Deliver raw footage to brand',
      detail: deliverySent ? `Sent ${formatAge(out?.age_hours)}` : 'Share Drive/WeTransfer link',
      tier: deliverySent ? 'green' : 'amber',
      status: deliverySent ? 'done' : 'active',
      completed: deliverySent,
    },
    {
      kind: 'send_invoice',
      label: `Issue invoice for ${fee || 'agreed fee'}`,
      detail: paymentRouting ? 'Done — payment in flight' : 'Email invoice with banking details',
      tier: 'green',
      status: paymentRouting ? 'done' : (deliverySent ? 'active' : 'todo'),
      completed: !!paymentRouting,
    },
    {
      kind: 'await_payment',
      label: paymentRouting ? `Payment routing via ${paymentRouting.platform}` : 'Waiting for payment',
      detail: paymentRouting
        ? `${paymentRouting.platform} processing — withdraw when it lands`
        : `Net-${deal.payment_terms_days || 30} from invoice date`,
      tier: paymentRouting ? 'green' : 'amber',
      status: paymentRouting ? 'waiting' : 'todo',
      completed: false,
    },
  ];

  // Apply AI verdict overrides if available. The AI audit uses the standard
  // 12-step vocabulary so we cross-map: `deliver_raw` is satisfied if the AI
  // said `send_script` OR `send_draft` is done (= we sent content of any kind
  // to the brand, which for UGC means raw delivery).
  if (aiVerdict) {
    const crossMap = {
      deliver_raw: ['send_script', 'send_draft', 'film_edit'],
    };
    for (const step of steps) {
      // Direct match first
      let v = aiVerdict[step.kind];
      // Then check cross-mapped equivalents — prefer any "done" verdict
      if (!v || v.status === 'unknown') {
        const candidates = crossMap[step.kind] || [];
        for (const altKind of candidates) {
          const alt = aiVerdict[altKind];
          if (alt && alt.status === 'done') { v = alt; break; }
          if (alt && alt.status !== 'unknown' && !v) v = alt;
        }
      }
      if (!v || !v.status || v.status === 'unknown') continue;
      step.status = v.status;
      step.completed = v.status === 'done';
      if (v.evidence && v.evidence.length > 6) step.detail = v.evidence;
      if (v.status === 'active' && step.tier !== 'red') step.tier = 'red';
      if (v.status === 'done' && step.tier === 'red') step.tier = 'green';
      step.confidence = v.confidence;
    }
  }
  return steps;
}

// ---- Helpers ----

function formatAge(hours) {
  if (hours == null) return 'recently';
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatDate(s) {
  if (!s) return '';
  const isoM = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoM) {
    try {
      const dt = new Date(s);
      if (!isNaN(dt.getTime())) {
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      }
    } catch {}
  }
  return s;
}

function formatRelativeDate(iso, daysOffset) {
  if (!iso) return null;
  try {
    const dt = new Date(iso);
    if (isNaN(dt.getTime())) return null;
    dt.setDate(dt.getDate() + daysOffset);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return null;
  }
}
