-- ============================================================================
-- Triibe Platform — deal desk schema
-- Written to be Postgres-COMPATIBLE so it lifts straight into Supabase later.
-- Runs on SQLite today (node:sqlite). Avoids SQLite-only syntax where practical.
--
-- Design notes:
--   * Every deal has a small, ALWAYS-PRESENT core (typed columns).
--   * The long tail of ~80 sparse fields from the legacy deals.json lives in
--     `extra` as JSON — queryable, never lost, but not cluttering the schema.
--   * funnel_stage = the 6-lane funnel the UI renders.
--   * state = lifecycle (open / won / lost / dormant), orthogonal to funnel_stage,
--     so dead/paused deals don't pollute the active funnel counts.
--   * Money is tracked in CENTS (integer) to avoid float rounding on splits.
--   * Commission split lives in `creators` (default 80/10/10) so it's per-creator
--     editable; computed amounts are derived, never hand-entered.
-- ============================================================================

-- ---- CREATORS ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS creators (
  id              TEXT PRIMARY KEY,          -- 'cooper', 'charlie', 'amie'
  name            TEXT NOT NULL,
  handle_ig       TEXT,
  handle_tiktok   TEXT,
  niche           TEXT,
  -- commission split (basis points; 8000/1000/1000 = 80/10/10)
  split_creator_bps  INTEGER NOT NULL DEFAULT 8000,
  split_riley_bps    INTEGER NOT NULL DEFAULT 1000,
  split_house_bps    INTEGER NOT NULL DEFAULT 1000,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- DEALS -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deals (
  id                TEXT PRIMARY KEY,        -- preserved from legacy deals.json
  brand             TEXT NOT NULL,
  brand_key         TEXT,                    -- normalized brand name for dedupe
  creator_id        TEXT REFERENCES creators(id),

  -- funnel + lifecycle
  funnel_stage      TEXT NOT NULL DEFAULT 'cold',   -- cold|conversation|pitching|in_works|active|completed
  state             TEXT NOT NULL DEFAULT 'open',   -- open|won|lost|dormant
  raw_stage         TEXT,                    -- original legacy stage (audit trail)
  priority          TEXT,                    -- critical|high|medium|low
  ball_in_court     TEXT,                    -- us|them|null

  -- money (cents)
  fee_cents         INTEGER,                 -- agreed/quoted fee
  fee_floor_cents   INTEGER,                 -- walk-away floor (from playbook)
  fee_status        TEXT,                    -- quoted|agreed|invoiced|paid|null
  paid_cents        INTEGER,                 -- amount collected so far

  -- contact
  contact_name      TEXT,
  contact_email     TEXT,
  contact_role      TEXT,
  contact_whatsapp  TEXT,
  agency            TEXT,

  -- categorization / clash inputs
  category          TEXT,                    -- ai_saas|outdoor|hydration|apparel|...
  exclusivity_required  INTEGER DEFAULT 0,
  exclusivity_days      INTEGER,
  exclusivity_terms     TEXT,
  posting_date          TEXT,                -- ISO date
  posting_window_start  TEXT,
  posting_window_end    TEXT,
  usage_rights          TEXT,
  raw_footage_no_posting INTEGER DEFAULT 0,  -- exempt from posting clash

  -- comms / sources
  primary_channel   TEXT,                    -- email|whatsapp
  thread_id         TEXT,                    -- gmail thread id
  gmail_url         TEXT,
  latest_msg_id     TEXT,

  -- activity (kept in sync by reconcile, NOT by hand)
  last_activity_at  TEXT,
  last_activity_by  TEXT,
  days_idle         INTEGER,
  next_action       TEXT,
  next_action_detail TEXT,
  has_brand_engagement INTEGER DEFAULT 0,

  -- everything else from legacy JSON, preserved verbatim
  flags             TEXT,                    -- JSON array
  extra             TEXT,                    -- JSON object (long-tail fields)

  -- AI-cached "where we are" summary (regenerated only when last_activity_at changes)
  ai_summary        TEXT,
  ai_summary_at     TEXT,
  ai_summary_for    TEXT,   -- last_activity_at value the summary was based on

  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deals_creator ON deals(creator_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage   ON deals(funnel_stage);
CREATE INDEX IF NOT EXISTS idx_deals_state   ON deals(state);
CREATE INDEX IF NOT EXISTS idx_deals_brandkey ON deals(brand_key);

-- ---- CONTRACTS ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contracts (
  id              TEXT PRIMARY KEY,
  deal_id         TEXT REFERENCES deals(id),
  file_path       TEXT,                      -- relative path under contracts/
  status          TEXT DEFAULT 'received',   -- received|reviewing|signed|expired
  fee_cents       INTEGER,
  payment_terms   TEXT,                      -- net-30 etc
  usage_rights    TEXT,
  usage_expiry    TEXT,                      -- ISO date — drives expiry alerts
  exclusivity_days INTEGER,
  redline_flags   TEXT,                      -- JSON array (perpetual, net-60+, excl>90d)
  signed_at       TEXT,
  extracted       TEXT,                      -- JSON of full extracted terms
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contracts_deal ON contracts(deal_id);

-- ---- PAYMENTS / INVOICING ----------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id              TEXT PRIMARY KEY,
  deal_id         TEXT REFERENCES deals(id),
  kind            TEXT NOT NULL DEFAULT 'invoice', -- invoice|payment
  amount_cents    INTEGER NOT NULL,
  status          TEXT DEFAULT 'pending',    -- pending|sent|paid|overdue
  net_terms_days  INTEGER DEFAULT 30,
  invoiced_at     TEXT,
  due_at          TEXT,
  paid_at         TEXT,
  method          TEXT,
  -- derived splits (cents) stored at payment time for an audit trail
  split_creator_cents INTEGER,
  split_riley_cents   INTEGER,
  split_house_cents   INTEGER,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_deal ON payments(deal_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- ---- THREADS + MESSAGES (Gmail + WhatsApp, unified) --------------------------
CREATE TABLE IF NOT EXISTS threads (
  id              TEXT PRIMARY KEY,          -- gmail thread id or wa:<chat>
  deal_id         TEXT REFERENCES deals(id),
  channel         TEXT NOT NULL,             -- email|whatsapp
  subject         TEXT,
  last_message_at TEXT,
  last_message_by TEXT,                      -- us|them
  last_snippet    TEXT,
  ball_in_court   TEXT,
  unread          INTEGER DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_threads_deal ON threads(deal_id);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT REFERENCES threads(id),
  channel         TEXT NOT NULL,
  sender          TEXT,
  from_us         INTEGER DEFAULT 0,
  sent_at         TEXT,
  snippet         TEXT,
  body            TEXT,
  raw_hash        TEXT,                      -- dedupe: never process same msg twice
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_hash ON messages(raw_hash);

-- ---- DRAFTS (AI-cooked replies awaiting your one-tap approval) ----------------
CREATE TABLE IF NOT EXISTS drafts (
  id              TEXT PRIMARY KEY,
  deal_id         TEXT REFERENCES deals(id),
  thread_id       TEXT,
  channel         TEXT NOT NULL,             -- email|whatsapp
  reply_to_msg_id TEXT,                      -- MUST be newest msg (draft_lint rule)
  subject         TEXT,
  body            TEXT NOT NULL,
  status          TEXT DEFAULT 'ready',      -- ready|approved|sent|rejected|stale|superseded
  rationale       TEXT,                      -- why this price/angle (shown to Riley)
  generated_by    TEXT DEFAULT 'local-stub', -- local-stub|openai:gpt-4o|...
  superseded_by   TEXT,                      -- id of rewrite that replaced this
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_drafts_deal ON drafts(deal_id);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);

-- ---- REMINDERS (from quick-capture "remind me ...") --------------------------
CREATE TABLE IF NOT EXISTS reminders (
  id              TEXT PRIMARY KEY,
  deal_id         TEXT REFERENCES deals(id),
  text            TEXT NOT NULL,
  due_at          TEXT,
  done            INTEGER DEFAULT 0,
  source          TEXT DEFAULT 'manual',     -- manual|voice|auto
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- CLASHES (computed by clash engine, not hand-maintained) -----------------
CREATE TABLE IF NOT EXISTS clashes (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,             -- exclusivity_block|ai_spacing|category_concentration|blackout|brand_duplicate
  severity        TEXT NOT NULL,             -- block|warn
  creator_id      TEXT,
  deal_a          TEXT,
  deal_b          TEXT,
  detail          TEXT,
  computed_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- ACTIVITY LOG (audit trail: who/what/when) -------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  who             TEXT,                      -- riley|claude|openai|system
  action          TEXT,
  deal_id         TEXT,
  summary         TEXT,
  meta            TEXT                       -- JSON
);
CREATE INDEX IF NOT EXISTS idx_activity_deal ON activity_log(deal_id);

-- ---- AI USAGE (spend tracking + guardrails) ----------------------------------
CREATE TABLE IF NOT EXISTS ai_usage (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  provider        TEXT,                      -- openai
  model           TEXT,                      -- gpt-4o-mini|gpt-4o|whisper-1
  operation       TEXT,                      -- parse|draft|voice|classify
  prompt_tokens   INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  est_cost_cents  INTEGER DEFAULT 0,
  deal_id         TEXT,
  dedupe_key      TEXT                       -- prevents double-charging same input
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_ts ON ai_usage(ts);

-- ---- CONFIG (key/value: kill switch, budgets, feature flags) -----------------
CREATE TABLE IF NOT EXISTS config (
  key             TEXT PRIMARY KEY,
  value           TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
