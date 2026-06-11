// DataProvider — the ONLY place the rest of the app touches the database.
// When we lift to Supabase, we write a SupabaseDataProvider with the same
// methods and the rest of the codebase doesn't change.
export class SqliteDataProvider {
  constructor(db) { this.db = db; }

  // ---- creators -----------------------------------------------------------
  listCreators() {
    return this.db.prepare('SELECT * FROM creators WHERE active=1 ORDER BY id').all();
  }

  // ---- deals --------------------------------------------------------------
  // Focus mode filters out cold intros / dead / dormant / >21d-idle deals.
  // Keep state='won' deals always (signed/completed should stay visible).
  // Caller passes `focus: true` to apply.
  static FOCUS_WHERE = `(
    state = 'won'
    OR (
      state = 'open'
      AND funnel_stage IN ('conversation','pitching','in_works','active')
      AND has_brand_engagement = 1
      AND last_activity_at >= datetime('now','-21 days')
    )
  )`;
  listDeals({ creator, funnel_stage, state, focus = false, limit = 1000 } = {}) {
    const where = [], args = [];
    if (focus)        { where.push(SqliteDataProvider.FOCUS_WHERE); }
    if (creator)      { where.push('creator_id = ?');   args.push(creator); }
    if (funnel_stage) { where.push('funnel_stage = ?'); args.push(funnel_stage); }
    if (state)        { where.push('state = ?');        args.push(state); }
    const sql = `SELECT * FROM deals ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY (fee_cents IS NULL), fee_cents DESC, last_activity_at DESC LIMIT ?`;
    args.push(limit);
    return this.db.prepare(sql).all(...args).map(parseDeal);
  }

  getDeal(id) {
    const r = this.db.prepare('SELECT * FROM deals WHERE id = ?').get(id);
    return r ? parseDeal(r) : null;
  }

  // Funnel counts: how many in each stage, and how many in each stage need YOU.
  // Also computes a "nudge" pseudo-stage: deals where the brand owes us a reply
  // but it's been >= 3 days since their last activity.
  funnelHealth({ creator, focus = false } = {}) {
    const filter = creator ? 'AND creator_id = ?' : '';
    const args = creator ? [creator] : [];
    const focusClause = focus ? `AND ${SqliteDataProvider.FOCUS_WHERE}` : '';
    // Count open + won (won = signed/completed; we want those visible in the funnel).
    const total = this.db.prepare(`
      SELECT funnel_stage, COUNT(*) c FROM deals
      WHERE state IN ('open','won') ${filter} ${focusClause}
      GROUP BY funnel_stage`).all(...args);
    const yours = this.db.prepare(`
      SELECT funnel_stage, COUNT(*) c FROM deals
      WHERE state IN ('open','won') AND ball_in_court='us' ${filter} ${focusClause}
      GROUP BY funnel_stage`).all(...args);

    // Nudge candidates — ball is on brand AND we haven't heard from them in 3+ days.
    const nudgeCount = this.db.prepare(`
      SELECT COUNT(*) c FROM deals
      WHERE state='open' AND ball_in_court='them'
        AND funnel_stage IN ('conversation','pitching','in_works','active')
        AND last_activity_at IS NOT NULL
        AND last_activity_at < datetime('now','-3 days')
        ${filter} ${focusClause}`).get(...args).c;
    // Display stages: merge in_works + active into a single "In the works" tile.
    const getCount  = s => total.find(r => r.funnel_stage === s)?.c || 0;
    const getYours  = s => yours.find(r => r.funnel_stage === s)?.c || 0;
    const stageRows = [
      { stage: 'conversation', count: getCount('conversation'), yours: getYours('conversation') },
      { stage: 'pitching',     count: getCount('pitching'),     yours: getYours('pitching') },
      { stage: 'in_works',     count: getCount('in_works') + getCount('active'),
                               yours: getYours('in_works') + getYours('active') },
      { stage: 'completed',    count: getCount('completed'),    yours: getYours('completed') },
    ];
    // Prepend Nudge as the first tile.
    return [{ stage: 'nudge', count: nudgeCount, yours: nudgeCount, label: 'Nudge' }, ...stageRows];
  }

  // Return the actual deals that match "needs nudge" (for the filter click).
  nudgeCandidates({ creator } = {}) {
    const filter = creator ? 'AND creator_id = ?' : '';
    const args = creator ? [creator] : [];
    return this.db.prepare(`
      SELECT * FROM deals
      WHERE state='open' AND ball_in_court='them'
        AND funnel_stage IN ('conversation','pitching','in_works','active')
        AND last_activity_at IS NOT NULL
        AND last_activity_at < datetime('now','-3 days')
        ${filter}
      ORDER BY last_activity_at ASC`).all(...args)
      .map(r => ({
        ...r,
        flags: r.flags ? JSON.parse(r.flags) : [],
        extra: r.extra ? JSON.parse(r.extra) : {},
      }));
  }

  // Money rollups for the dashboard "$X booked / $Y collected / $Z outstanding"
  moneySummary({ creator, monthStartIso } = {}) {
    const filter = creator ? 'AND creator_id = ?' : '';
    const args = creator ? [creator] : [];
    // "Booked" = signed/executed (state=won) OR contract paperwork is in flight
    // AND we've moved past pitching into in_works/active.
    // Excludes bare "terms_agreed" verbal yes, at_risk, and anything still in
    // pitching (even "terms_agreed_pending_client" stays in pitching).
    const BOOKED_RAW_STAGES = "('contract_received','contract_signed','signed','in_revision','in_production','confirmed')";
    const booked = this.db.prepare(`SELECT COALESCE(SUM(fee_cents),0) v
      FROM deals
      WHERE state != 'lost'
        AND fee_cents IS NOT NULL
        AND (
          state = 'won'
          OR (funnel_stage IN ('in_works','active') AND raw_stage IN ${BOOKED_RAW_STAGES})
        ) ${filter}`).get(...args).v;
    const paid = this.db.prepare(`SELECT COALESCE(SUM(amount_cents),0) v FROM payments
      WHERE status='paid' ${creator ? 'AND deal_id IN (SELECT id FROM deals WHERE creator_id=?)' : ''}`).get(...(creator?[creator]:[])).v;
    const rileyCut = this.db.prepare(`SELECT COALESCE(SUM(split_riley_cents),0) v FROM payments
      WHERE status='paid' ${creator ? 'AND deal_id IN (SELECT id FROM deals WHERE creator_id=?)' : ''}`).get(...(creator?[creator]:[])).v;
    return { booked_cents: booked, collected_cents: paid, riley_cut_cents: rileyCut,
             outstanding_cents: Math.max(0, booked - paid) };
  }

  // Today action queue: a small ranked list of "thing that needs you now".
  todayActions({ creator, focus = false, limit = 10 } = {}) {
    // Priority: contract reviews, drafts ready, redlined flags, idle > 7d, payments overdue.
    const filter = creator ? 'AND d.creator_id = ?' : '';
    const args = creator ? [creator] : [];
    const focusClause = focus
      ? `AND (d.state = 'won' OR (d.state='open' AND d.funnel_stage IN ('conversation','pitching','in_works','active') AND d.has_brand_engagement=1 AND d.last_activity_at >= datetime('now','-21 days')))`
      : '';
    const drafts = this.db.prepare(`
      SELECT 'draft' kind, dr.id ref, d.id deal_id, d.brand, d.creator_id, d.fee_cents,
             'Draft ready to send' title, dr.body detail, 'high' priority, dr.created_at ts
      FROM drafts dr JOIN deals d ON d.id = dr.deal_id
      WHERE dr.status='ready' ${filter} ${focusClause}
      ORDER BY dr.created_at DESC LIMIT 5`).all(...args);
    const yourMove = this.db.prepare(`
      SELECT 'move' kind, d.id ref, d.id deal_id, d.brand, d.creator_id, d.fee_cents,
             COALESCE(d.next_action, 'Your move') title,
             COALESCE(d.next_action_detail, '') detail,
             CASE WHEN d.priority='hot' OR d.priority='critical' THEN 'critical'
                  WHEN d.priority='high' THEN 'high' ELSE 'medium' END priority,
             d.last_activity_at ts
      FROM deals d
      WHERE d.state='open' AND d.ball_in_court='us' ${filter} ${focusClause}
      ORDER BY (d.priority='hot') DESC, (d.priority='critical') DESC, d.last_activity_at DESC
      LIMIT ?`).all(...args, limit);
    return [...drafts, ...yourMove].slice(0, limit);
  }

  // ---- payments / money ---------------------------------------------------
  logPayment({ id, deal_id, amount_cents, paid_at = null, method = null, note = null }) {
    const deal = this.db.prepare('SELECT creator_id FROM deals WHERE id=?').get(deal_id);
    if (!deal) throw new Error(`unknown deal ${deal_id}`);
    const sp = this.db.prepare('SELECT split_creator_bps, split_riley_bps, split_house_bps FROM creators WHERE id=?').get(deal.creator_id)
      || { split_creator_bps: 8000, split_riley_bps: 1000, split_house_bps: 1000 };
    const cCreator = Math.round(amount_cents * sp.split_creator_bps / 10000);
    const cRiley   = Math.round(amount_cents * sp.split_riley_bps   / 10000);
    const cHouse   = amount_cents - cCreator - cRiley;
    this.db.prepare(`INSERT INTO payments (id, deal_id, kind, amount_cents, status, paid_at, method,
                       split_creator_cents, split_riley_cents, split_house_cents, note)
                     VALUES (?, ?, 'payment', ?, 'paid', ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET amount_cents=excluded.amount_cents`)
      .run(id, deal_id, amount_cents, paid_at, method, cCreator, cRiley, cHouse, note);
    return { id, deal_id, amount_cents, splits: { creator: cCreator, riley: cRiley, house: cHouse } };
  }

  // ---- drafts -------------------------------------------------------------
  listReadyDrafts() {
    // Auto-expire drafts that Riley cooked but never sent. If a "ready" draft
    // has been sitting for >1 hour, it's stale — the context has moved on.
    // Mark abandoned so it stops appearing anywhere and doesn't haunt Gmail.
    this.db.prepare(`UPDATE drafts SET status='abandoned', updated_at=datetime('now')
      WHERE status='ready' AND datetime(created_at) < datetime('now','-1 hour')`).run();
    return this.db.prepare(`SELECT dr.*, d.brand, d.creator_id, d.fee_cents
      FROM drafts dr JOIN deals d ON d.id = dr.deal_id
      WHERE dr.status='ready' ORDER BY dr.created_at DESC`).all();
  }
  saveDraft(draft) {
    this.db.prepare(`INSERT INTO drafts (id, deal_id, thread_id, channel, reply_to_msg_id,
        subject, body, status, rationale, generated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET body=excluded.body, status='ready',
        rationale=excluded.rationale, updated_at=datetime('now')`)
      .run(draft.id, draft.deal_id, draft.thread_id || null, draft.channel,
           draft.reply_to_msg_id || null, draft.subject || null, draft.body,
           draft.status || 'ready', draft.rationale || null, draft.generated_by || 'local-stub');
    return draft;
  }
  setDraftStatus(id, status) {
    this.db.prepare('UPDATE drafts SET status=?, updated_at=datetime(\'now\') WHERE id=?').run(status, id);
  }

  // ---- reminders ----------------------------------------------------------
  addReminder({ id, deal_id = null, text, due_at = null, source = 'manual' }) {
    this.db.prepare(`INSERT INTO reminders (id, deal_id, text, due_at, source)
                     VALUES (?, ?, ?, ?, ?)`).run(id, deal_id, text, due_at, source);
    return { id, deal_id, text, due_at, source };
  }
  listReminders({ pending = true } = {}) {
    return this.db.prepare(`SELECT * FROM reminders ${pending ? 'WHERE done=0' : ''} ORDER BY due_at`).all();
  }

  // ---- activity log -------------------------------------------------------
  log({ who, action, deal_id = null, summary = null, meta = null }) {
    this.db.prepare(`INSERT INTO activity_log (who, action, deal_id, summary, meta)
                     VALUES (?, ?, ?, ?, ?)`)
      .run(who, action, deal_id, summary, meta ? JSON.stringify(meta) : null);
  }
}

function parseDeal(r) {
  if (!r) return r;
  return {
    ...r,
    flags: tryJSON(r.flags, []),
    extra: tryJSON(r.extra, {}),
    has_brand_engagement: !!r.has_brand_engagement,
    exclusivity_required: !!r.exclusivity_required,
    raw_footage_no_posting: !!r.raw_footage_no_posting,
  };
}
function tryJSON(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }
