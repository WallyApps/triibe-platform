// PgDataProvider — Postgres (Supabase) implementation of the DataProvider
// interface. Same method names/shapes as the old SqliteDataProvider, but every
// method is async (the pg shim's prepare().get/all/run return promises). SQLite
// date functions in the SQL are translated to Postgres by db/pg.js at run time.
export class PgDataProvider {
  constructor(db) { this.db = db; }

  // ---- creators -----------------------------------------------------------
  async listCreators() {
    return this.db.prepare('SELECT * FROM creators WHERE active=1 ORDER BY id').all();
  }

  // ---- deals --------------------------------------------------------------
  static FOCUS_WHERE = `(
    state = 'won'
    OR (
      state = 'open'
      AND funnel_stage IN ('conversation','pitching','in_works','active')
      AND has_brand_engagement = 1
      AND last_activity_at >= datetime('now','-21 days')
    )
  )`;
  async listDeals({ creator, funnel_stage, state, focus = false, limit = 1000 } = {}) {
    const where = [], args = [];
    if (focus)        { where.push(PgDataProvider.FOCUS_WHERE); }
    if (creator)      { where.push('creator_id = ?');   args.push(creator); }
    if (funnel_stage) { where.push('funnel_stage = ?'); args.push(funnel_stage); }
    if (state)        { where.push('state = ?');        args.push(state); }
    const sql = `SELECT * FROM deals ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY (fee_cents IS NULL), fee_cents DESC, last_activity_at DESC LIMIT ?`;
    args.push(limit);
    const rows = await this.db.prepare(sql).all(...args);
    return rows.map(parseDeal);
  }

  async getDeal(id) {
    const r = await this.db.prepare('SELECT * FROM deals WHERE id = ?').get(id);
    return r ? parseDeal(r) : null;
  }

  // Funnel counts: how many in each stage, and how many in each stage need YOU.
  async funnelHealth({ creator, focus = false } = {}) {
    const filter = creator ? 'AND creator_id = ?' : '';
    const args = creator ? [creator] : [];
    const focusClause = focus ? `AND ${PgDataProvider.FOCUS_WHERE}` : '';
    const total = await this.db.prepare(`
      SELECT funnel_stage, COUNT(*) c FROM deals
      WHERE state IN ('open','won') ${filter} ${focusClause}
      GROUP BY funnel_stage`).all(...args);
    const yours = await this.db.prepare(`
      SELECT funnel_stage, COUNT(*) c FROM deals
      WHERE state IN ('open','won') AND ball_in_court='us' ${filter} ${focusClause}
      GROUP BY funnel_stage`).all(...args);

    const nudgeCount = (await this.db.prepare(`
      SELECT COUNT(*) c FROM deals
      WHERE state='open' AND ball_in_court='them'
        AND funnel_stage IN ('conversation','pitching','in_works','active')
        AND last_activity_at IS NOT NULL
        AND last_activity_at < datetime('now','-3 days')
        ${filter} ${focusClause}`).get(...args)).c;
    const getCount  = s => total.find(r => r.funnel_stage === s)?.c || 0;
    const getYours  = s => yours.find(r => r.funnel_stage === s)?.c || 0;
    const stageRows = [
      { stage: 'conversation', count: getCount('conversation'), yours: getYours('conversation') },
      { stage: 'pitching',     count: getCount('pitching'),     yours: getYours('pitching') },
      { stage: 'in_works',     count: getCount('in_works') + getCount('active'),
                               yours: getYours('in_works') + getYours('active') },
      { stage: 'completed',    count: getCount('completed'),    yours: getYours('completed') },
    ];
    return [{ stage: 'nudge', count: nudgeCount, yours: nudgeCount, label: 'Nudge' }, ...stageRows];
  }

  async nudgeCandidates({ creator } = {}) {
    const filter = creator ? 'AND creator_id = ?' : '';
    const args = creator ? [creator] : [];
    const rows = await this.db.prepare(`
      SELECT * FROM deals
      WHERE state='open' AND ball_in_court='them'
        AND funnel_stage IN ('conversation','pitching','in_works','active')
        AND last_activity_at IS NOT NULL
        AND last_activity_at < datetime('now','-3 days')
        ${filter}
      ORDER BY last_activity_at ASC`).all(...args);
    return rows.map(r => ({
      ...r,
      flags: r.flags ? JSON.parse(r.flags) : [],
      extra: r.extra ? JSON.parse(r.extra) : {},
    }));
  }

  // Money rollups for the dashboard.
  async moneySummary({ creator, monthStartIso } = {}) {
    const filter = creator ? 'AND creator_id = ?' : '';
    const args = creator ? [creator] : [];
    const BOOKED_RAW_STAGES = "('contract_received','contract_signed','signed','in_revision','in_production','confirmed')";
    const booked = (await this.db.prepare(`SELECT COALESCE(SUM(fee_cents),0) v
      FROM deals
      WHERE state != 'lost'
        AND fee_cents IS NOT NULL
        AND (
          state = 'won'
          OR (funnel_stage IN ('in_works','active') AND raw_stage IN ${BOOKED_RAW_STAGES})
        ) ${filter}`).get(...args)).v;
    const paid = (await this.db.prepare(`SELECT COALESCE(SUM(amount_cents),0) v FROM payments
      WHERE status='paid' ${creator ? 'AND deal_id IN (SELECT id FROM deals WHERE creator_id=?)' : ''}`).get(...(creator?[creator]:[]))).v;
    const rileyCut = (await this.db.prepare(`SELECT COALESCE(SUM(split_riley_cents),0) v FROM payments
      WHERE status='paid' ${creator ? 'AND deal_id IN (SELECT id FROM deals WHERE creator_id=?)' : ''}`).get(...(creator?[creator]:[]))).v;
    return { booked_cents: booked, collected_cents: paid, riley_cut_cents: rileyCut,
             outstanding_cents: Math.max(0, booked - paid) };
  }

  // Today action queue.
  async todayActions({ creator, focus = false, limit = 10 } = {}) {
    const filter = creator ? 'AND d.creator_id = ?' : '';
    const args = creator ? [creator] : [];
    const focusClause = focus
      ? `AND (d.state = 'won' OR (d.state='open' AND d.funnel_stage IN ('conversation','pitching','in_works','active') AND d.has_brand_engagement=1 AND d.last_activity_at >= datetime('now','-21 days')))`
      : '';
    const drafts = await this.db.prepare(`
      SELECT 'draft' kind, dr.id ref, d.id deal_id, d.brand, d.creator_id, d.fee_cents,
             'Draft ready to send' title, dr.body detail, 'high' priority, dr.created_at ts
      FROM drafts dr JOIN deals d ON d.id = dr.deal_id
      WHERE dr.status='ready' ${filter} ${focusClause}
      ORDER BY dr.created_at DESC LIMIT 5`).all(...args);
    const yourMove = await this.db.prepare(`
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
  async logPayment({ id, deal_id, amount_cents, paid_at = null, method = null, note = null }) {
    const deal = await this.db.prepare('SELECT creator_id FROM deals WHERE id=?').get(deal_id);
    if (!deal) throw new Error(`unknown deal ${deal_id}`);
    const sp = (await this.db.prepare('SELECT split_creator_bps, split_riley_bps, split_house_bps FROM creators WHERE id=?').get(deal.creator_id))
      || { split_creator_bps: 8000, split_riley_bps: 1000, split_house_bps: 1000 };
    const cCreator = Math.round(amount_cents * sp.split_creator_bps / 10000);
    const cRiley   = Math.round(amount_cents * sp.split_riley_bps   / 10000);
    const cHouse   = amount_cents - cCreator - cRiley;
    await this.db.prepare(`INSERT INTO payments (id, deal_id, kind, amount_cents, status, paid_at, method,
                       split_creator_cents, split_riley_cents, split_house_cents, note)
                     VALUES (?, ?, 'payment', ?, 'paid', ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET amount_cents=excluded.amount_cents`)
      .run(id, deal_id, amount_cents, paid_at, method, cCreator, cRiley, cHouse, note);
    return { id, deal_id, amount_cents, splits: { creator: cCreator, riley: cRiley, house: cHouse } };
  }

  // ---- drafts -------------------------------------------------------------
  async listReadyDrafts() {
    await this.db.prepare(`UPDATE drafts SET status='abandoned', updated_at=datetime('now')
      WHERE status='ready' AND datetime(created_at) < datetime('now','-1 hour')`).run();
    return this.db.prepare(`SELECT dr.*, d.brand, d.creator_id, d.fee_cents
      FROM drafts dr JOIN deals d ON d.id = dr.deal_id
      WHERE dr.status='ready' ORDER BY dr.created_at DESC`).all();
  }
  async saveDraft(draft) {
    await this.db.prepare(`INSERT INTO drafts (id, deal_id, thread_id, channel, reply_to_msg_id,
        subject, body, status, rationale, generated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET body=excluded.body, status='ready',
        rationale=excluded.rationale, updated_at=datetime('now')`)
      .run(draft.id, draft.deal_id, draft.thread_id || null, draft.channel,
           draft.reply_to_msg_id || null, draft.subject || null, draft.body,
           draft.status || 'ready', draft.rationale || null, draft.generated_by || 'local-stub');
    return draft;
  }
  async setDraftStatus(id, status) {
    await this.db.prepare('UPDATE drafts SET status=?, updated_at=datetime(\'now\') WHERE id=?').run(status, id);
  }

  // ---- reminders ----------------------------------------------------------
  async addReminder({ id, deal_id = null, text, due_at = null, source = 'manual' }) {
    await this.db.prepare(`INSERT INTO reminders (id, deal_id, text, due_at, source)
                     VALUES (?, ?, ?, ?, ?)`).run(id, deal_id, text, due_at, source);
    return { id, deal_id, text, due_at, source };
  }
  async listReminders({ pending = true } = {}) {
    return this.db.prepare(`SELECT * FROM reminders ${pending ? 'WHERE done=0' : ''} ORDER BY due_at`).all();
  }

  // ---- activity log -------------------------------------------------------
  async log({ who, action, deal_id = null, summary = null, meta = null }) {
    await this.db.prepare(`INSERT INTO activity_log (who, action, deal_id, summary, meta)
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
