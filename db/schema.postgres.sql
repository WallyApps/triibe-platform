-- ============================================================================
-- Triibe Platform — deal-desk schema, POSTGRES edition (Supabase).
-- Reconstructed from db/schema.sql PLUS exhaustive analysis of every SQL
-- statement in the codebase (the SQLite schema.sql was incomplete — several
-- tables and columns only ever existed in the original dev's local .db file).
--
-- Conventions:
--   * Timestamps that take part in date math are real `timestamptz` (SQLite
--     compared TEXT, but Postgres needs proper types for now()/interval compares).
--     The pg shim (db/pg.js) installs a type parser so these read back as ISO
--     'Z' strings — matching what the app produces with new Date().toISOString().
--   * Date-only / legacy free-form fields (posting_date, posting_window_*,
--     revisit_at, usage_expiry) stay TEXT (string-compared in the app).
--   * JSON is stored as TEXT (the app does JSON.parse/stringify; only one query
--     uses json_extract, handled by the shim casting text->jsonb at query time).
--   * Money in CENTS (integer). Booleans are INTEGER 0/1 (matches app code).
-- ============================================================================

create table if not exists creators (
  id              text primary key,
  name            text not null,
  handle_ig       text,
  handle_tiktok   text,
  niche           text,
  split_creator_bps  integer not null default 8000,
  split_riley_bps    integer not null default 1000,
  split_house_bps    integer not null default 1000,
  active          integer not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists deals (
  id                text primary key,
  brand             text not null,
  brand_key         text,
  creator_id        text references creators(id),
  funnel_stage      text not null default 'cold',
  state             text not null default 'open',
  raw_stage         text,
  priority          text,
  ball_in_court     text,
  fee_cents         integer,
  fee_floor_cents   integer,
  fee_status        text,
  paid_cents        integer,
  payment_terms_days integer,
  contact_name      text,
  contact_email     text,
  contact_role      text,
  contact_whatsapp  text,
  agency            text,
  category          text,
  exclusivity_required  integer default 0,
  exclusivity_days      integer,
  exclusivity_terms     text,
  posting_date          text,
  posting_window_start  text,
  posting_window_end    text,
  usage_rights          text,
  raw_footage_no_posting integer default 0,
  primary_channel   text,
  thread_id         text,
  gmail_url         text,
  latest_msg_id     text,
  last_activity_at  timestamptz,
  last_activity_by  text,
  days_idle         integer,
  next_action       text,
  next_action_detail text,
  has_brand_engagement integer default 0,
  flags             text,
  extra             text,
  obligations       text,
  ai_summary        text,
  ai_summary_at     timestamptz,
  ai_summary_for    timestamptz,
  lifecycle_state   text,
  lifecycle_audited_at timestamptz,
  managed_by        text,
  deliverable       text,
  deliverable_summary text,
  -- parked-deal feature
  revisit_at        text,
  park_reason       text,
  parked_at         timestamptz,
  revived_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_deals_creator on deals(creator_id);
create index if not exists idx_deals_stage   on deals(funnel_stage);
create index if not exists idx_deals_state   on deals(state);
create index if not exists idx_deals_brandkey on deals(brand_key);

create table if not exists threads (
  id              text primary key,
  deal_id         text references deals(id),
  channel         text not null,
  subject         text,
  last_message_at timestamptz,
  last_message_by text,
  last_snippet    text,
  ball_in_court   text,
  unread          integer default 0,
  read_through_at timestamptz,
  pitch_dismissed_at timestamptz,
  pitch_creator   text,
  pitch_category  text,
  pitch_classified_at timestamptz,
  updated_at      timestamptz not null default now()
);
create index if not exists idx_threads_deal on threads(deal_id);

create table if not exists messages (
  id              text primary key,
  thread_id       text references threads(id),
  channel         text not null,
  sender          text,
  from_us         integer default 0,
  sent_at         timestamptz,
  snippet         text,
  body            text,
  raw_hash        text,
  classification  text,
  media_type      text,
  media_path      text,
  media_mime      text,
  media_filename  text,
  media_size      integer,
  created_at      timestamptz not null default now()
);
create index if not exists idx_messages_thread on messages(thread_id);
create unique index if not exists idx_messages_hash on messages(raw_hash);

create table if not exists contracts (
  id              text primary key,
  deal_id         text references deals(id),
  file_path       text,
  file_hash       text,
  file_name       text,
  status          text default 'received',
  fee_cents       integer,
  payment_terms   text,
  usage_rights    text,
  usage_expiry    text,
  exclusivity_days integer,
  redline_flags   text,
  signed_at       timestamptz,
  extracted       text,
  dismissed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_contracts_deal on contracts(deal_id);

create table if not exists payments (
  id              text primary key,
  deal_id         text references deals(id),
  kind            text not null default 'invoice',
  amount_cents    integer not null,
  status          text default 'pending',
  net_terms_days  integer default 30,
  invoiced_at     timestamptz,
  due_at          timestamptz,
  paid_at         timestamptz,
  method          text,
  split_creator_cents integer,
  split_riley_cents   integer,
  split_house_cents   integer,
  note            text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_payments_deal on payments(deal_id);
create index if not exists idx_payments_status on payments(status);

create table if not exists drafts (
  id              text primary key,
  deal_id         text references deals(id),
  thread_id       text,
  channel         text not null,
  reply_to_msg_id text,
  subject         text,
  body            text not null,
  status          text default 'ready',
  rationale       text,
  generated_by    text default 'local-stub',
  superseded_by   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_drafts_deal on drafts(deal_id);
create index if not exists idx_drafts_status on drafts(status);

create table if not exists reminders (
  id              text primary key,
  deal_id         text references deals(id),
  text            text not null,
  due_at          timestamptz,
  done            integer default 0,
  source          text default 'manual',
  created_at      timestamptz not null default now()
);

create table if not exists clashes (
  id              text primary key,
  kind            text not null,
  severity        text not null,
  creator_id      text,
  deal_a          text,
  deal_b          text,
  detail          text,
  computed_at     timestamptz not null default now()
);

create table if not exists activity_log (
  id              bigint generated always as identity primary key,
  ts              timestamptz not null default now(),
  who             text,
  action          text,
  deal_id         text,
  summary         text,
  meta            text
);
create index if not exists idx_activity_deal on activity_log(deal_id);

create table if not exists ai_usage (
  id              bigint generated always as identity primary key,
  ts              timestamptz not null default now(),
  provider        text,
  model           text,
  operation       text,
  prompt_tokens   integer default 0,
  completion_tokens integer default 0,
  est_cost_cents  integer default 0,
  deal_id         text,
  dedupe_key      text
);
create index if not exists idx_ai_usage_ts on ai_usage(ts);

create table if not exists config (
  key             text primary key,
  value           text,
  updated_at      timestamptz not null default now()
);

-- ---- tables the app uses but never created in SQLite -------------------------

-- Auto-promotion notifications (stage/fee change proposals + undo trail).
create table if not exists notifications (
  id                bigint generated always as identity primary key,
  kind              text,
  deal_id           text,
  title             text,
  body              text,
  prior_raw_stage   text,
  prior_funnel_stage text,
  prior_state       text,
  prior_fee_cents   integer,
  new_raw_stage     text,
  new_funnel_stage  text,
  new_state         text,
  new_fee_cents     integer,
  created_at        timestamptz not null default now(),
  dismissed_at      timestamptz,
  undone_at         timestamptz
);
create index if not exists idx_notifications_open
  on notifications(dismissed_at, undone_at);

-- Attachments (email + WhatsApp media) tied to a message/thread.
create table if not exists message_attachments (
  id                  bigint generated always as identity primary key,
  message_id          text,
  thread_id           text,
  channel             text,
  media_path          text,
  media_filename      text,
  media_mime          text,
  media_size          integer,
  media_type          text,
  source_attachment_id text,
  created_at          timestamptz not null default now()
);
create unique index if not exists idx_msg_att_unique
  on message_attachments(message_id, media_path);

-- Per-deal cache of AI-extracted "next actions", keyed by deal_id.
create table if not exists deal_actions_cache (
  deal_id       text primary key,
  actions_json  text,
  cache_key     text,
  generated_at  timestamptz not null default now()
);

-- Which "this week" actions have been ticked complete (one row per deal+kind).
create table if not exists action_completions (
  deal_id       text not null,
  action_kind   text not null,
  completed_at  timestamptz not null default now(),
  primary key (deal_id, action_kind)
);
