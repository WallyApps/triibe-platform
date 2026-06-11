// Initialize the SQLite database from schema.sql + seed config defaults.
// Uses node:sqlite (built into Node 22+) — zero npm deps.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DB_PATH = join(ROOT, 'data', 'triibe.db');

export function openDb() {
  return new DatabaseSync(DB_PATH);
}

export function initSchema(db) {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);

  // Seed creators (split defaults 80/10/10 from the plan).
  const upsertCreator = db.prepare(`
    INSERT INTO creators (id, name, handle_ig, handle_tiktok, niche)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name`);
  upsertCreator.run('cooper', 'Cooper Simson', '@coopersimson', null, 'ai_saas');
  upsertCreator.run('charlie', 'Charlie Stringer', '@charliestringer', '@charliestringer', 'outdoor');
  upsertCreator.run('amie', 'Amie', null, null, null);

  // Seed config defaults (spend guardrails + kill switch + budget).
  const cfg = db.prepare(`INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO NOTHING`);
  cfg.run('ai_enabled', 'false');             // master kill switch (AI off until paid phase)
  cfg.run('ai_monthly_cap_cents', '2000');    // $20 hard cap
  cfg.run('ai_daily_token_budget', '500000');
  cfg.run('ai_max_calls_per_hour', '60');
  cfg.run('ai_budget_alert_50', 'false');
  cfg.run('ai_budget_alert_80', 'false');
  cfg.run('data_provider', 'sqlite');         // -> 'supabase' later
  cfg.run('draft_provider', 'local-stub');    // -> 'openai' later
  cfg.run('schema_version', '0.1.0');
  cfg.run('wa_auto_pull', 'true');           // auto-refresh WA every 5 min
}

// Run directly: `node db/init.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  initSchema(db);
  console.log('✓ DB initialized at data/triibe.db');
  const t = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all();
  console.log('  tables:', t.map(r => r.name).join(', '));
  db.close();
}
