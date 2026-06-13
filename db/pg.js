// Async Postgres data layer — the SQLite -> Supabase bridge.
//
// node:sqlite's DatabaseSync is synchronous: db.prepare(sql).get/all/run(...).
// Postgres (pg) is async. This module exposes the SAME shape — a handle with
// .prepare()/.exec() — but the statement methods are async, so the rest of the
// codebase migrates by adding `await` (and marking callers async) rather than
// rewriting every query.
//
// A dialect translator rewrites the common SQLite-isms to Postgres at query
// time: `?` placeholders -> `$1,$2,...`, datetime()/julianday()/json_extract().
// The handful that can't be auto-translated (INSERT OR IGNORE/REPLACE,
// lastInsertRowid) are fixed at their call sites.
import pg from 'pg';

const { Pool } = pg;

// Read timestamptz/timestamp back as ISO-8601 'Z' strings (e.g.
// "2026-06-13T10:00:00.000Z") so the app sees the SAME format it writes with
// new Date().toISOString() — string slicing / localeCompare / JSON all keep
// working unchanged. (Default pg would hand back JS Date objects.)
const asISO = (v) => (v == null ? v : new Date(v).toISOString());
pg.types.setTypeParser(1184, asISO); // timestamptz
pg.types.setTypeParser(1114, asISO); // timestamp without time zone

let _pool = null;
export function pool() {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set — cannot connect to Postgres');
  _pool = new Pool({
    connectionString,
    // Supabase requires SSL; the pooler cert isn't in the local trust store.
    ssl: { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return _pool;
}

// ---- SQLite -> Postgres dialect translation --------------------------------
// Pure string rewrite. Conservative: only touches well-known SQLite forms.
export function translate(sql) {
  // 1) `?` -> `$1,$2,...`, skipping anything inside single-quoted string literals.
  let out = '';
  let n = 0;
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      // handle escaped '' inside strings by toggling normally (pg uses '' to escape)
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (ch === '?' && !inStr) {
      out += '$' + ++n;
      continue;
    }
    out += ch;
  }
  sql = out;

  // 2) datetime('now', '<modifier>') -> (now() + interval '<modifier>')
  //    SQLite modifiers like '-21 days' / '-1 hour' are valid PG interval text.
  sql = sql.replace(/datetime\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi,
    (_, mod) => `(now() + interval '${mod}')`);

  // 3) datetime('now') -> now()
  sql = sql.replace(/datetime\(\s*'now'\s*\)/gi, 'now()');

  // 4) datetime(<expr>) -> (<expr>)::timestamptz   (no quotes/parens in <expr>)
  sql = sql.replace(/datetime\(\s*([^()']+?)\s*\)/gi, '($1)::timestamptz');

  // 5) julianday('now') - julianday(X) -> day difference as float
  sql = sql.replace(/julianday\(\s*'now'\s*\)\s*-\s*julianday\(\s*([^()]+?)\s*\)/gi,
    (_, x) => `(extract(epoch from (now() - (${x})::timestamptz)) / 86400.0)`);

  // 5b) date('now', ...) family -> timestamptz expressions (these are compared
  //     against timestamptz `ts`/`_at` columns). The one place date('now',...)
  //     is compared to a TEXT date column (draft.openai posting_date) is
  //     rewritten at its call site to use to_char(), so it never reaches here.
  sql = sql.replace(/date\(\s*'now'\s*,\s*'start of month'\s*\)/gi, "date_trunc('month', now())");
  sql = sql.replace(/date\(\s*'now'\s*,\s*'start of year'\s*\)/gi, "date_trunc('year', now())");
  sql = sql.replace(/date\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi, (_, mod) => `(now() + interval '${mod}')`);
  sql = sql.replace(/date\(\s*'now'\s*\)/gi, "date_trunc('day', now())");

  // 6) json_extract(col, '$.key') -> ((col)::jsonb->>'key')
  sql = sql.replace(/json_extract\(\s*([a-z_][\w.]*)\s*,\s*'\$\.(\w+)'\s*\)/gi,
    (_, col, key) => `((${col})::jsonb->>'${key}')`);

  return sql;
}

// ---- prepared-statement shim ------------------------------------------------
// Mirrors node:sqlite's prepare().get/all/run, but async.
//   get -> first row (or undefined)
//   all -> array of rows
//   run -> { changes, rows }   (rows is non-empty only when SQL has RETURNING)
function prepare(sql) {
  const text = translate(sql);
  return {
    get: async (...args) => {
      const r = await pool().query(text, args);
      return r.rows[0];
    },
    all: async (...args) => {
      const r = await pool().query(text, args);
      return r.rows;
    },
    run: async (...args) => {
      const r = await pool().query(text, args);
      return { changes: r.rowCount, rows: r.rows };
    },
  };
}

// Multi-statement DDL / bulk SQL. `?` translation still applies but exec is
// normally used without params.
async function exec(sql) {
  await pool().query(translate(sql));
}

// Raw escape hatch — returns the full pg result.
async function query(sql, params = []) {
  return pool().query(translate(sql), params);
}

// The DB handle the rest of the app holds (was a DatabaseSync instance).
export function makeHandle() {
  return { prepare, exec, query, pool };
}

// Convenience module-level accessors (some call sites import these directly).
export { prepare, exec, query };

export async function closePool() {
  if (_pool) { await _pool.end(); _pool = null; }
}
