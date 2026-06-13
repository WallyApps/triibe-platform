// Provider registry — central place that decides which implementation answers
// each capability. Swapping providers happens HERE, not all over the codebase.
//
// Postgres migration note: the DB is now async (pg). To keep providers() and
// the per-request Proxy in server/index.js synchronous, config is loaded once
// into an in-memory cache (loadConfig) at startup via ensureInit(); cfg() reads
// that cache synchronously. Call ensureInit() (await) before serving requests
// (server boot, or at the top of each serverless invocation).
import { openDb } from '../../db/init.js';
import { PgDataProvider } from './data.pg.js';
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
  if (!_db) _db = openDb();
  return _db;
}

// In-memory config cache so cfg() can stay synchronous.
let _config = new Map();
export async function loadConfig() {
  const rows = await db().prepare('SELECT key, value FROM config').all();
  _config = new Map(rows.map(r => [r.key, r.value]));
}
function cfg(key, fallback) {
  return _config.has(key) ? _config.get(key) : fallback;
}
async function setCfg(key, value) {
  await db().prepare(`INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=now()`).run(key, value);
  _config.set(key, value);
}

// One-time idempotent schema touch-ups. In Postgres ADD COLUMN IF NOT EXISTS is
// native, so these are no-ops once schema.postgres.sql has been applied — kept
// as a safety net for older databases.
async function runIdempotentMigrations() {
  const ddl = [
    'ALTER TABLE deals ADD COLUMN IF NOT EXISTS revisit_at text',
    'ALTER TABLE deals ADD COLUMN IF NOT EXISTS park_reason text',
    'ALTER TABLE deals ADD COLUMN IF NOT EXISTS parked_at timestamptz',
    'ALTER TABLE deals ADD COLUMN IF NOT EXISTS revived_at timestamptz',
  ];
  for (const stmt of ddl) { try { await db().exec(stmt); } catch { /* ignore */ } }
}

// Idempotent async startup: run migrations + warm the config cache. Safe to call
// many times — the work happens once and subsequent calls await the same promise.
let _initPromise = null;
export function ensureInit() {
  if (!_initPromise) {
    _initPromise = (async () => {
      await runIdempotentMigrations();
      await loadConfig();
    })();
  }
  return _initPromise;
}

export function providers() {
  // Read config (cache) -> pick provider.
  const draftKind  = cfg('draft_provider', 'local-stub');
  const aiEnabled  = cfg('ai_enabled', 'false') === 'true';

  const spend = new SpendGuard(db());

  // AI providers only activate when the kill switch is ON. Otherwise we fall
  // back to local stubs even if draft_provider says 'openai' — a missing key or
  // accidental config can never cause an unexpected charge.
  const useOpenAI = aiEnabled && draftKind === 'openai' && !!process.env.OPENAI_API_KEY;

  return {
    data:    new PgDataProvider(db()),
    draft:   useOpenAI ? new OpenAIDraftProvider(db(), spend) : new LocalStubDraftProvider(db()),
    parse:   useOpenAI ? new OpenAIParseProvider(db(), spend) : new LocalStubParseProvider(db()),
    voice:   new LocalStubVoiceProvider(db()),
    inbound: new LocalStubInboundProvider(db()),
    push:    new LocalPushProvider(db()),
    waSend:  new LocalWhatsAppSendProvider(db()),
    spend,
    db,
    cfg,
    setCfg,
  };
}
