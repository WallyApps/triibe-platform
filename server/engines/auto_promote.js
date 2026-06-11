// auto_promote.js — automatic deal-stage advancement based on real-world signals
// (contract uploads, brand emails saying "yes let's lock it in"), with full
// snapshot + Undo support via the notifications table.
//
// Two paths:
//   1. promoteFromContract({db, deal, contract}) — fires when a contract file
//      matched to a deal is uploaded. raw_stage -> contract_received (or signed
//      if AI says executed). Fee gets set from extracted terms if missing.
//   2. promoteFromEmailSignal({db, deal, msg, openaiKey}) — fires after Gmail
//      ingest. AI scores the brand's last message + checks for a $ amount that
//      matches the quoted fee. If both → raw_stage = terms_agreed.
//
// Both write to `notifications` with the prior state so Undo can revert.

// Map raw stages to funnel + state (mirrors config/stage_map.json — kept inline
// for speed, the cases we use are small).
function deriveFunnel(raw_stage) {
  const map = {
    contract_received: { funnel_stage: 'in_works', state: 'open' },
    signed:           { funnel_stage: 'in_works', state: 'won' },
    contract_signed:  { funnel_stage: 'in_works', state: 'won' },
    terms_agreed:     { funnel_stage: 'in_works', state: 'open' },
  };
  return map[raw_stage] || null;
}

function snapshotDeal(deal) {
  return {
    prior_raw_stage:    deal.raw_stage || null,
    prior_funnel_stage: deal.funnel_stage || null,
    prior_state:        deal.state || null,
    prior_fee_cents:    deal.fee_cents || null,
  };
}

// Parse "net 30" / "net-30" / "net 60 from invoice" → integer days, null otherwise
function parseNetDays(s) {
  if (!s) return null;
  const m = String(s).toLowerCase().match(/net[\s\-_]*(\d{1,3})/);
  return m ? parseInt(m[1], 10) : null;
}

function applyStage(db, deal, { raw_stage, fee_cents, payment_terms_days }) {
  const derived = deriveFunnel(raw_stage);
  if (!derived) return null;
  // Coerce undefined → null so SQLite bind doesn't blow up on missing columns
  const newFee = (fee_cents && (!deal.fee_cents || deal.fee_cents <= 0))
    ? fee_cents
    : (deal.fee_cents ?? null);
  const newPay = payment_terms_days || deal.payment_terms_days || null;
  db.prepare(`UPDATE deals SET raw_stage=?, funnel_stage=?, state=?, fee_cents=?,
    payment_terms_days=COALESCE(?, payment_terms_days),
    updated_at=datetime('now') WHERE id=?`)
    .run(raw_stage, derived.funnel_stage, derived.state, newFee, newPay, deal.id);
  return {
    new_raw_stage: raw_stage,
    new_funnel_stage: derived.funnel_stage,
    new_state: derived.state,
    new_fee_cents: newFee,
  };
}

function logNotification(db, { kind, deal, title, body, snapshot, applied }) {
  const r = db.prepare(`INSERT INTO notifications
    (kind, deal_id, title, body, prior_raw_stage, prior_funnel_stage, prior_state, prior_fee_cents,
     new_raw_stage, new_funnel_stage, new_state, new_fee_cents)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(kind, deal.id, title, body,
         snapshot.prior_raw_stage, snapshot.prior_funnel_stage, snapshot.prior_state, snapshot.prior_fee_cents,
         applied.new_raw_stage, applied.new_funnel_stage, applied.new_state, applied.new_fee_cents);
  return r.lastInsertRowid;
}

// TIER 1 — contract uploaded
// Returns { promoted: bool, notification_id?: number, reason?: string }
export function promoteFromContract({ db, deal, extracted }) {
  if (!deal) return { promoted: false, reason: 'no deal' };
  // Already past in_works? leave it alone.
  if (deal.funnel_stage === 'in_works' && (deal.raw_stage === 'signed' || deal.raw_stage === 'contract_signed')) {
    return { promoted: false, reason: 'already signed' };
  }
  // is_brief means it's a campaign brief not a real contract — don't auto-promote
  if (extracted?.is_brief === true) return { promoted: false, reason: 'looks like brief, not contract' };

  const snapshot = snapshotDeal(deal);
  const fee_cents = extracted?.fee_usd ? Math.round(extracted.fee_usd * 100) : null;
  // Parse "net X" out of the AI-extracted payment_terms so the payment-due
  // chip uses the brand's actual terms, not a hardcoded 30 days.
  const payment_terms_days = parseNetDays(extracted?.payment_terms);
  // contract_received is the safe default; a fully-signed contract usually shows
  // both parties signed in the text but we can't reliably tell from extraction.
  const raw_stage = 'contract_received';
  const applied = applyStage(db, deal, { raw_stage, fee_cents, payment_terms_days });
  if (!applied) return { promoted: false, reason: 'no funnel mapping' };

  const feeStr = applied.new_fee_cents ? '$' + (applied.new_fee_cents/100).toLocaleString() : 'fee TBD';
  const title = `📜 ${deal.brand} sent the contract`;
  const body  = `Locked at ${feeStr}. Moved to In Works.`;
  const notification_id = logNotification(db, {
    kind: 'auto_promote_contract',
    deal, title, body, snapshot, applied
  });
  return { promoted: true, notification_id, applied };
}

// TIER 2 — Gmail brand reply suggests we have a deal
// Uses keyword match + $ amount match. Optional AI fallback for ambiguous cases.
const LOCK_IN_PATTERNS = [
  /\bsounds? good\b/i, /\blet'?s (do|run|go) (it|this|with)\b/i, /\blet'?s lock\b/i,
  /\bsend (over )?(the )?contract\b/i, /\bapproved?\b/i, /\bgreen ?lit\b/i,
  /\bwe'?re (a )?go\b/i, /\blet'?s move (forward|ahead)\b/i, /\bbook(ed)? (it|him|her|them)\b/i,
  /\bwe'?d like to (move|proceed|go) (forward|ahead)\b/i, /\bperfect\b.{0,30}\b(work|move|proceed)\b/i,
  /\bworks for (us|me)\b/i, /\bok(ay)? let'?s do it\b/i, /\baccept(ed|ing)? (the |your )?(offer|rate|terms)\b/i,
];

// Exported so the leads/rate-pitched view can detect "brand sent a counter"
// in the latest brand reply on a pitching-stage deal.
export function extractDollarCents(text) { return extractDollar(text); }
function extractDollar(text) {
  // Returns first $-amount found, in cents. Handles "$2,000", "2,000 USD", "$2k".
  const t = text.replace(/[,\s]/g, '');
  let m = t.match(/\$(\d+(?:\.\d+)?)\s*(k|K)\b/);
  if (m) return Math.round(parseFloat(m[1]) * 1000 * 100);
  m = t.match(/\$(\d{3,7}(?:\.\d{2})?)/);
  if (m) return Math.round(parseFloat(m[1]) * 100);
  m = text.match(/(\d{3,7})\s*(?:usd|dollars)\b/i);
  if (m) return Math.round(parseFloat(m[1].replace(/,/g,'')) * 100);
  return null;
}

export function promoteFromEmailSignal({ db, deal, msgText }) {
  if (!deal || !msgText) return { promoted: false, reason: 'no input' };
  // Only auto-promote from rate_sent / negotiating — anything more advanced
  // (or already won) needs no help; anything earlier (conversation) is too risky.
  const eligible = ['rate_sent','negotiating','terms_agreed_pending_client'];
  if (!eligible.includes(deal.raw_stage || '')) return { promoted: false, reason: 'stage not eligible' };

  const lockIn = LOCK_IN_PATTERNS.some(re => re.test(msgText));
  if (!lockIn) return { promoted: false, reason: 'no lock-in language' };

  const dollarFound = extractDollar(msgText);
  // Require either:
  //   (a) brand mentions a $ that's within 5% of our quoted fee (we asked for X, they said "$X works")
  //   (b) deal already has a fee_cents AND lock-in language is unambiguous ("send the contract" / "approved")
  const strongLockIn = /\bsend (over )?(the )?contract\b|\bapproved?\b|\baccept(ed|ing)? (the |your )?(offer|rate|terms)\b/i.test(msgText);
  let feeOk = false;
  let inferredFee = null;
  if (dollarFound && deal.fee_cents) {
    const delta = Math.abs(dollarFound - deal.fee_cents) / deal.fee_cents;
    if (delta <= 0.05) { feeOk = true; inferredFee = dollarFound; }
  } else if (strongLockIn && deal.fee_cents) {
    feeOk = true;
  }
  if (!feeOk) return { promoted: false, reason: 'no fee confirmation' };

  const snapshot = snapshotDeal(deal);
  const applied = applyStage(db, deal, { raw_stage: 'terms_agreed', fee_cents: inferredFee });
  if (!applied) return { promoted: false, reason: 'no funnel mapping' };

  const feeStr = applied.new_fee_cents ? '$' + (applied.new_fee_cents/100).toLocaleString() : 'fee TBD';
  const title = `💰 ${deal.brand} locked at ${feeStr}`;
  const body  = `Bumped to In Works — they confirmed terms.`;
  const notification_id = logNotification(db, {
    kind: 'auto_promote_email',
    deal, title, body, snapshot, applied
  });
  return { promoted: true, notification_id, applied };
}

// Undo — reverts a notification's state change. Idempotent.
// Two flavors:
//   1. lead_promoted: the deal was NEWLY CREATED from an orphan contract/pitch,
//      so prior_* columns are NULL → can't revert stage. Instead, DELETE the
//      deal, unlink the contract (so it returns to the New Leads tray), and
//      drop any messages/threads we created during promotion.
//   2. Auto-promote (contract upload changes existing deal's stage): restore
//      the prior stage/state/fee from the notification snapshot.
export function undoPromotion({ db, notificationId }) {
  const n = db.prepare(`SELECT * FROM notifications WHERE id=?`).get(notificationId);
  if (!n) return { undone: false, reason: 'not found' };
  if (n.undone_at) return { undone: false, reason: 'already undone' };

  const isFreshCreation = n.kind === 'lead_promoted' && !n.prior_funnel_stage;
  if (isFreshCreation && n.deal_id) {
    const dealId = n.deal_id;
    // Unlink any contracts pointing at this deal so they return to leads tray
    db.prepare(`UPDATE contracts SET deal_id=NULL WHERE deal_id=?`).run(dealId);
    // Unlink any threads we linked to this deal
    db.prepare(`UPDATE threads SET deal_id=NULL WHERE deal_id=?`).run(dealId);
    // NULL deal_id on this + any other notifications referencing the deal,
    // so the FK constraint doesn't hold the deal alive.
    db.prepare(`UPDATE notifications SET deal_id=NULL WHERE deal_id=?`).run(dealId);
    // Delete the deal itself
    db.prepare(`DELETE FROM deals WHERE id=?`).run(dealId);
  } else {
    // Standard revert: restore prior stage/state/fee
    db.prepare(`UPDATE deals SET raw_stage=?, funnel_stage=?, state=?, fee_cents=?,
      updated_at=datetime('now') WHERE id=?`)
      .run(n.prior_raw_stage, n.prior_funnel_stage, n.prior_state, n.prior_fee_cents, n.deal_id);
  }
  db.prepare(`UPDATE notifications SET undone_at=datetime('now') WHERE id=?`).run(notificationId);
  return { undone: true };
}

export function listActiveNotifications({ db, hours = 48 }) {
  return db.prepare(`SELECT * FROM notifications
    WHERE dismissed_at IS NULL AND undone_at IS NULL
      AND datetime(created_at) >= datetime('now', '-' || ? || ' hours')
    ORDER BY created_at DESC LIMIT 20`).all(String(hours));
}

export function dismissNotification({ db, id }) {
  db.prepare(`UPDATE notifications SET dismissed_at=datetime('now') WHERE id=?`).run(id);
  return { dismissed: true };
}

// ---- E-sign envelope detection ---------------------------------------------
// DocuSign/HelloSign/PandaDoc/etc never include the PDF as an attachment —
// they email a link. We can't auto-pull the file, but we can detect the email
// pattern + surface a banner so Riley knows action is needed (or that a
// contract just got executed → auto-promote to signed).

const ESIGN_SENDER_DOMAINS = [
  'docusign.net', 'docusign.com',
  'hellosign.com', 'dropboxsign.com',
  'pandadoc.com', 'pandadoc-mail.com',
  'adobesign.com', 'echosign.com',
  'signnow.com', 'signrequest.com',
  'juro.com', 'concord.app',
  'eversign.com', 'sertifi.com',
];

function esignKindFromEmail({ fromHeader, subjectHeader }) {
  const from = (fromHeader || '').toLowerCase();
  const subj = (subjectHeader || '').toLowerCase();
  const isEsignSender = ESIGN_SENDER_DOMAINS.some(d => from.includes(d));
  // Also catch raw subject patterns even when sender is unusual (some companies
  // route through their own SMTP relay).
  const subjectLooksLikeEsign =
    /\bplease\s+docusign\b/i.test(subj) ||
    /\bplease\s+(e-?)?sign\b/i.test(subj) ||
    /\bsignature\s+requested\b/i.test(subj) ||
    /\bcompleted:\s/i.test(subj) ||
    /\bcomplete[d]?\s*-\s*(.+)\s+(signed|agreement)/i.test(subj) ||
    /\bdocusign\b.*\benvelope\b/i.test(subj) ||
    /^action required:.*\b(sign|signature)/i.test(subj);
  if (!isEsignSender && !subjectLooksLikeEsign) return null;

  // What kind?
  if (/\bcompleted?:\s|\ball parties.*signed|\bexecut(ed|ion)|\benvelope\s+completed?\b|\bsigned\s+by\s+all\b/i.test(subj)) {
    return 'completed';
  }
  if (/^reminder:|^auto-?reminder:/i.test(subj)) {
    return 'reminder';
  }
  if (/\bplease\s+(docusign|sign|review)|\bsignature\s+requested|\baction\s+required/i.test(subj)) {
    return 'pending';
  }
  // E-sign sender with no obvious signal → assume pending
  if (isEsignSender) return 'pending';
  return null;
}

// Try to figure out which brand/deal this envelope belongs to by scanning the
// subject + body for known brand names. Falls back to null if no clear match.
function guessDealForEsign({ db, subjectHeader, bodyText }) {
  const blob = `${subjectHeader || ''} ${(bodyText || '').slice(0, 500)}`.toLowerCase();
  const deals = db.prepare(`SELECT id, brand, brand_key FROM deals
    WHERE state != 'lost' ORDER BY last_activity_at DESC NULLS LAST`).all();
  for (const d of deals) {
    const candidates = [d.brand, d.brand_key].filter(Boolean).map(s => s.toLowerCase());
    for (const c of candidates) {
      // Strip .ai/.com/.io/.app TLDs so "Sintra.ai" matches "Sintra"
      const stripped = c.replace(/\.(ai|com|io|co|app|inc)\b/g, '').trim();
      if (stripped.length < 3) continue;
      if (blob.includes(stripped)) return d;
    }
  }
  return null;
}

// Detect e-sign emails during Gmail ingest. Returns { kind, notification_id }
// or null when nothing matched.
export function detectEsignEmail({ db, fromHeader, subjectHeader, bodyText, threadDealId }) {
  const kind = esignKindFromEmail({ fromHeader, subjectHeader });
  if (!kind) return null;

  // Resolve a deal: prefer the thread's deal_id, fall back to brand scan
  let deal = threadDealId
    ? db.prepare('SELECT * FROM deals WHERE id=?').get(threadDealId)
    : null;
  if (!deal) deal = guessDealForEsign({ db, subjectHeader, bodyText });

  // Dedupe — don't fire two banners for the same envelope in the same hour
  const existing = db.prepare(`SELECT id FROM notifications
    WHERE kind=? AND deal_id IS ?
      AND datetime(created_at) > datetime('now','-2 hours')
    LIMIT 1`).get('esign_' + kind, deal?.id || null);
  if (existing) return { kind, notification_id: existing.id, deduped: true };

  // On "completed" with a matched deal: auto-promote to signed (state=won)
  let title, body, applied = {
    new_raw_stage: null, new_funnel_stage: null, new_state: null, new_fee_cents: null
  };
  let snapshot = {
    prior_raw_stage: null, prior_funnel_stage: null, prior_state: null, prior_fee_cents: null
  };
  if (kind === 'completed' && deal && deal.state !== 'won') {
    snapshot = snapshotDeal(deal);
    const r = applyStage(db, deal, { raw_stage: 'signed', fee_cents: null });
    if (r) applied = r;
    title = `✅ ${deal.brand} contract executed`;
    body  = `Fully signed via e-sign — auto-promoted to Signed.`;
  } else if (kind === 'completed') {
    title = deal ? `✅ ${deal.brand} contract executed` : `✅ Contract executed`;
    body  = deal ? `Already on Signed.` : `Couldn't match this to a deal — check Gmail.`;
  } else if (kind === 'pending') {
    title = deal ? `🖊️ ${deal.brand} sent a contract to sign` : `🖊️ E-sign envelope received`;
    body  = deal ? `DocuSign/HelloSign — open Gmail to review + sign.` : `Couldn't match to a deal — check Gmail.`;
  } else if (kind === 'reminder') {
    title = deal ? `🔔 Reminder: ${deal.brand} contract still unsigned` : `🔔 E-sign reminder`;
    body  = `They're waiting on your signature.`;
  }

  const id = db.prepare(`INSERT INTO notifications
    (kind, deal_id, title, body, prior_raw_stage, prior_funnel_stage, prior_state, prior_fee_cents,
     new_raw_stage, new_funnel_stage, new_state, new_fee_cents)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('esign_' + kind, deal?.id || null, title, body,
         snapshot.prior_raw_stage, snapshot.prior_funnel_stage, snapshot.prior_state, snapshot.prior_fee_cents,
         applied.new_raw_stage, applied.new_funnel_stage, applied.new_state, applied.new_fee_cents).lastInsertRowid;

  return { kind, notification_id: id, deal_id: deal?.id || null, promoted: kind === 'completed' && !!applied.new_raw_stage };
}
