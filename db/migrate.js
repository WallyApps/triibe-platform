// Migrate legacy ~/triibe-ops deals.json -> SQLite (data/triibe.db).
// READ-ONLY source: migration/source/deals.snapshot.json (a locked copy).
// NON-DESTRUCTIVE: never touches ~/triibe-ops. Idempotent: re-runnable (UPSERT).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, initSchema } from './init.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SNAPSHOT = join(ROOT, 'migration', 'source', 'deals.snapshot.json');
const STAGE_MAP = join(ROOT, 'config', 'stage_map.json');

// Fields we lift into typed columns. Everything else -> extra JSON.
const CORE_FIELDS = new Set([
  'id','brand','brand_key','creator','stage','priority','ball_in_court',
  'fee_usd','fee_floor_usd','fee_status','paid_amount_usd',
  'contact_name','contact_email','contact_role','contact_whatsapp','agency',
  'category','exclusivity_required','exclusivity_days','exclusivity_terms',
  'posting_date','posting_window_start','posting_window_end','usage_rights','usage_rights_v2',
  'channel','channels','thread_id','gmail_url','latest_msg_id',
  'last_activity_at','last_activity_by','days_idle','next_action','next_action_detail',
  'has_brand_engagement','flags'
]);

const dollarsToCents = v => (v === null || v === undefined || v === '') ? null : Math.round(Number(v) * 100);
const bool = v => v ? 1 : 0;

function main() {
  const db = openDb();
  initSchema(db); // safe: CREATE IF NOT EXISTS + seed

  const data = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const stageMapCfg = JSON.parse(readFileSync(STAGE_MAP, 'utf8'));
  const { map: STAGEMAP, default: STAGE_DEFAULT } = stageMapCfg;

  const deals = data.deals || [];
  // Auto-add any creator we discover (so a new roster member never silently
  // gets dropped on import — that "(none)=1" miss should be impossible).
  const seenCreators = new Set();
  for (const d of deals) if (d.creator) seenCreators.add(d.creator);
  const upsertCreator = db.prepare(`INSERT INTO creators (id, name) VALUES (?, ?)
    ON CONFLICT(id) DO NOTHING`);
  for (const c of seenCreators) upsertCreator.run(c, c[0].toUpperCase() + c.slice(1));
  const knownCreators = seenCreators;

  const upsert = db.prepare(`
    INSERT INTO deals (
      id, brand, brand_key, creator_id, funnel_stage, state, raw_stage, priority, ball_in_court,
      fee_cents, fee_floor_cents, fee_status, paid_cents,
      contact_name, contact_email, contact_role, contact_whatsapp, agency,
      category, exclusivity_required, exclusivity_days, exclusivity_terms,
      posting_date, posting_window_start, posting_window_end, usage_rights, raw_footage_no_posting,
      primary_channel, thread_id, gmail_url, latest_msg_id,
      last_activity_at, last_activity_by, days_idle, next_action, next_action_detail,
      has_brand_engagement, flags, extra, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET
      brand=excluded.brand, brand_key=excluded.brand_key, creator_id=excluded.creator_id,
      funnel_stage=excluded.funnel_stage, state=excluded.state, raw_stage=excluded.raw_stage,
      priority=excluded.priority, ball_in_court=excluded.ball_in_court,
      fee_cents=excluded.fee_cents, fee_floor_cents=excluded.fee_floor_cents,
      fee_status=excluded.fee_status, paid_cents=excluded.paid_cents,
      contact_name=excluded.contact_name, contact_email=excluded.contact_email,
      contact_role=excluded.contact_role, contact_whatsapp=excluded.contact_whatsapp, agency=excluded.agency,
      category=excluded.category, exclusivity_required=excluded.exclusivity_required,
      exclusivity_days=excluded.exclusivity_days, exclusivity_terms=excluded.exclusivity_terms,
      posting_date=excluded.posting_date, posting_window_start=excluded.posting_window_start,
      posting_window_end=excluded.posting_window_end, usage_rights=excluded.usage_rights,
      raw_footage_no_posting=excluded.raw_footage_no_posting,
      primary_channel=excluded.primary_channel, thread_id=excluded.thread_id,
      gmail_url=excluded.gmail_url, latest_msg_id=excluded.latest_msg_id,
      last_activity_at=excluded.last_activity_at, last_activity_by=excluded.last_activity_by,
      days_idle=excluded.days_idle, next_action=excluded.next_action,
      next_action_detail=excluded.next_action_detail, has_brand_engagement=excluded.has_brand_engagement,
      flags=excluded.flags, extra=excluded.extra, updated_at=datetime('now')
  `);

  const insertPayment = db.prepare(`
    INSERT INTO payments (id, deal_id, kind, amount_cents, status, paid_at,
      split_creator_cents, split_riley_cents, split_house_cents, note)
    VALUES (?, ?, 'payment', ?, 'paid', ?, ?, ?, ?, 'migrated from legacy paid_amount_usd')
    ON CONFLICT(id) DO NOTHING`);

  const getCreatorSplit = db.prepare(`SELECT split_creator_bps, split_riley_bps, split_house_bps FROM creators WHERE id=?`);

  let n = 0, unmappedStages = new Set(), paymentsLogged = 0, byStage = {}, byState = {};
  const tx = db.prepare('BEGIN'); tx.run();
  try {
    for (const d of deals) {
      const raw = d.stage || '';
      let sm = STAGEMAP[raw] || STAGE_DEFAULT;
      if (!STAGEMAP[raw]) unmappedStages.add(raw);

      // Override #1: deals with payment received are COMPLETED/WON, regardless
      // of legacy raw stage (which often gets set to "dead" once archived).
      const flagsArr = Array.isArray(d.flags) ? d.flags : [];
      const isPaid = !!d.paid_amount_usd && d.paid_amount_usd > 0;
      const isClosed = isPaid || d.completed_at
        || flagsArr.some(f => /completed_paid|completed_done|paid_and_closed/i.test(f));
      if (isClosed) sm = { funnel_stage: 'completed', state: 'won' };

      // Override #2: deals that have posted but not yet paid -> ACTIVE/OPEN
      // (currently fulfilling, awaiting payment).
      else if (d.posted_date && !isPaid) {
        const today = new Date().toISOString().slice(0,10);
        if (d.posted_date <= today) sm = { funnel_stage: 'active', state: 'open' };
      }
      byStage[sm.funnel_stage] = (byStage[sm.funnel_stage] || 0) + 1;
      byState[sm.state] = (byState[sm.state] || 0) + 1;

      const creator = knownCreators.has(d.creator) ? d.creator : null;
      const flags = Array.isArray(d.flags) ? d.flags : [];
      const rawFootage = bool(flags.some(f => /raw_footage_no_posting/i.test(f)));

      // long-tail fields -> extra JSON
      const extra = {};
      for (const [k, v] of Object.entries(d)) if (!CORE_FIELDS.has(k)) extra[k] = v;

      const primaryChannel = d.channel || (Array.isArray(d.channels) ? d.channels[0] : null) || 'email';
      const paidCents = dollarsToCents(d.paid_amount_usd);

      upsert.run(
        d.id, d.brand || '(unknown)', d.brand_key || null, creator,
        sm.funnel_stage, sm.state, raw, d.priority || null, d.ball_in_court || null,
        dollarsToCents(d.fee_usd), dollarsToCents(d.fee_floor_usd), d.fee_status || null, paidCents,
        d.contact_name || null, d.contact_email || null, d.contact_role || null,
        d.contact_whatsapp || null, d.agency || null,
        d.category || null, bool(d.exclusivity_required), d.exclusivity_days ?? null, d.exclusivity_terms || null,
        d.posting_date || null, d.posting_window_start || null, d.posting_window_end || null,
        d.usage_rights_v2 || d.usage_rights || null, rawFootage,
        primaryChannel, d.thread_id || null, d.gmail_url || null, d.latest_msg_id || null,
        d.last_activity_at || null, d.last_activity_by || null, d.days_idle ?? null,
        d.next_action || null, d.next_action_detail || null,
        bool(d.has_brand_engagement), JSON.stringify(flags), JSON.stringify(extra)
      );
      n++;

      // If this deal has a recorded payment, log it with computed splits.
      if (paidCents && creator) {
        const sp = getCreatorSplit.get(creator) || { split_creator_bps:8000, split_riley_bps:1000, split_house_bps:1000 };
        const cCreator = Math.round(paidCents * sp.split_creator_bps / 10000);
        const cRiley   = Math.round(paidCents * sp.split_riley_bps   / 10000);
        const cHouse   = paidCents - cCreator - cRiley; // remainder to avoid rounding drift
        insertPayment.run(`${d.id}__migrated`, d.id, paidCents, d.paid_date || d.completed_at || null,
          cCreator, cRiley, cHouse);
        paymentsLogged++;
      }
    }
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }

  // ---- verification report ----
  const total = db.prepare('SELECT COUNT(*) c FROM deals').get().c;
  const byCreator = db.prepare(`SELECT COALESCE(creator_id,'(none)') cr, COUNT(*) c FROM deals GROUP BY cr ORDER BY c DESC`).all();
  const fundedOpen = db.prepare(`SELECT funnel_stage, COUNT(*) c FROM deals WHERE state='open' GROUP BY funnel_stage`).all();

  console.log('\n=== MIGRATION COMPLETE ===');
  console.log(`Source deals: ${deals.length}  ->  rows in DB: ${total}  (upserted ${n})`);
  console.log('By creator:', byCreator.map(r => `${r.cr}=${r.c}`).join('  '));
  console.log('By funnel_stage:', JSON.stringify(byStage));
  console.log('By state:', JSON.stringify(byState));
  console.log('Open-only funnel:', fundedOpen.map(r => `${r.funnel_stage}=${r.c}`).join('  '));
  console.log(`Payments logged (with splits): ${paymentsLogged}`);
  if (unmappedStages.size) console.log('⚠ Unmapped stages (used default):', [...unmappedStages].join(', '));
  else console.log('✓ All legacy stages mapped.');
  db.close();
}

main();
