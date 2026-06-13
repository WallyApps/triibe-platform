// Initialize the Postgres (Supabase) database from schema.postgres.sql and seed
// creators + config defaults. Async (pg). Run directly: `node db/init.js`
// (requires DATABASE_URL in the environment / .env).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeHandle, closePool } from './pg.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.postgres.sql');

export function openDb() {
  return makeHandle();
}

export async function initSchema(db) {
  await db.exec(readFileSync(SCHEMA_PATH, 'utf8'));

  // Seed creators (split defaults 80/10/10).
  const upsertCreator = db.prepare(`
    INSERT INTO creators (id, name, handle_ig, handle_tiktok, niche)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name`);
  await upsertCreator.run('cooper', 'Cooper Simson', '@coopersimson', null, 'ai_saas');
  await upsertCreator.run('charlie', 'Charlie Stringer', '@charliestringer', '@charliestringer', 'outdoor');
  await upsertCreator.run('amie', 'Amie', null, null, null);

  // Seed config defaults (spend guardrails + kill switch + budget).
  const cfg = db.prepare(`INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO NOTHING`);
  await cfg.run('ai_enabled', 'false');             // master kill switch (AI off until paid phase)
  await cfg.run('ai_monthly_cap_cents', '2000');    // $20 hard cap
  await cfg.run('ai_daily_token_budget', '500000');
  await cfg.run('ai_max_calls_per_hour', '60');
  await cfg.run('ai_budget_alert_50', 'false');
  await cfg.run('ai_budget_alert_80', 'false');
  await cfg.run('data_provider', 'supabase');        // Postgres-backed now
  await cfg.run('draft_provider', 'local-stub');     // -> 'openai' later
  await cfg.run('schema_version', '0.2.0');
  await cfg.run('wa_auto_pull', 'true');             // auto-refresh WA every 5 min
}

// Run directly: `node db/init.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  await initSchema(db);
  console.log('✓ Postgres schema initialized + seeded');
  const t = await db.prepare(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`
  ).all();
  console.log('  tables:', t.map(r => r.table_name).join(', '));
  await closePool();
}
