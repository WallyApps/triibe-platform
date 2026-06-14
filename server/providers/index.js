// Provider registry — central place that decides which implementation answers
// each capability. Swapping SQLite -> Supabase or local-stub -> OpenAI happens
// HERE, not all over the codebase. That's the whole point of the interface.
import { openDb } from '../../db/init.js';
import { SqliteDataProvider } from './data.sqlite.js';
import { LocalStubDraftProvider } from './draft.local.js';
import { LocalStubParseProvider } from './parse.local.js';
import { OpenAIDraftProvider, OpenAIParseProvider } from './draft.openai.js';
import { LocalStubVoiceProvider } from './voice.local.js';
import { LocalStubInboundProvider } from './inbound.local.js';
import { LocalPushProvider } from './push.local.js';
import { LocalWhatsAppSendProvider } from './whatsappsend.local.js';
import { SpendGuard } from './spend_guard.js';

let _db = null;
function db() {
  if (_db) return _db;
  _db = openDb();
  runIdempotentMigrations(_db);
  return _db;
}

// One-time additive migrations that run on first DB open. ALTER TABLE ADD COLUMN
// in SQLite errors on duplicate, so we wrap each in try/catch — clean way to
// keep schema evolution in code without a separate migrations table.
function runIdempotentMigrations(d) {
  const ddl = [
    // Parked-deals feature: deals you want to revisit later (Lea-style "reach
    // out when schedule aligns"). state='dormant' marks it parked; revisit_at
    // is when the daily revival job should pop it back into Pitches.
    "ALTER TABLE deals ADD COLUMN revisit_at TEXT",
    "ALTER TABLE deals ADD COLUMN park_reason TEXT",
    "ALTER TABLE deals ADD COLUMN parked_at TEXT",
    "ALTER TABLE deals ADD COLUMN revived_at TEXT",
  ];
  for (const stmt of ddl) { try { d.exec(stmt); } catch { /* already exists */ } }

  // Scheduled Sends (#141) — drafts queued to fire at a later time. Riley cooks
  // a reply Sunday evening, picks "Schedule for Sun 8pm", and a background
  // worker fires the send when the time arrives so it lands in the brand's
  // inbox first thing Monday morning. CREATE TABLE IF NOT EXISTS is idempotent
  // by itself; no try/catch needed.
  d.exec(`CREATE TABLE IF NOT EXISTS scheduled_sends (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    scheduled_for   TEXT NOT NULL,                    -- ISO datetime when to fire
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending|sent|failed|canceled
    channel         TEXT NOT NULL,                    -- email|whatsapp
    deal_id         TEXT,
    thread_id       TEXT,
    draft_id        TEXT,                             -- if linked to a Drafts row
    body            TEXT NOT NULL,
    to_addr         TEXT,                             -- email recipient or WA chat
    fired_at        TEXT,                             -- when send was attempted
    error           TEXT,
    sent_message_id TEXT                              -- gmail msg id or wa msg id
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_sched_sends_status ON scheduled_sends(status, scheduled_for)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_sched_sends_deal ON scheduled_sends(deal_id)`);
}

function cfg(key, fallback) {
  const row = db().prepare('SELECT value FROM config WHERE key=?').get(key);
  return row ? row.value : fallback;
}

export function providers() {
  // Read config -> pick provider. Today everything is local; later flip via DB.
  const dataKind   = cfg('data_provider',  'sqlite');
  const draftKind  = cfg('draft_provider', 'local-stub');
  const aiEnabled  = cfg('ai_enabled', 'false') === 'true';

  const spend = new SpendGuard(db());

  // AI providers only activate when the kill switch is ON. Otherwise we fall
  // back to local stubs even if draft_provider says 'openai' — this means a
  // missing key or accidental config can never cause an unexpected charge.
  const useOpenAI = aiEnabled && draftKind === 'openai' && !!process.env.OPENAI_API_KEY;

  return {
    data:    dataKind === 'sqlite' ? new SqliteDataProvider(db())
                                   : (() => { throw new Error('supabase provider not wired yet'); })(),
    draft:   useOpenAI ? new OpenAIDraftProvider(db(), spend) : new LocalStubDraftProvider(db()),
    parse:   useOpenAI ? new OpenAIParseProvider(db(), spend) : new LocalStubParseProvider(db()),
    voice:   new LocalStubVoiceProvider(db()),
    inbound: new LocalStubInboundProvider(db()),
    push:    new LocalPushProvider(db()),
    waSend:  new LocalWhatsAppSendProvider(db()),
    spend,
    db,
    cfg,
  };
}
