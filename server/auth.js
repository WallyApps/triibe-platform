// Supabase Auth gate for the node:http API.
//
// The browser SPA signs in with Google via supabase-js and attaches the
// resulting JWT as `Authorization: Bearer <token>` on every /api request. Here
// we verify that token against Supabase and enforce an email allowlist.
//
// Env:
//   SUPABASE_URL / SUPABASE_ANON_KEY  (or NEXT_PUBLIC_* equivalents) — required
//   AUTH_REQUIRED         default 'true'  (set 'false' to disable the gate)
//   ALLOWED_EMAIL_DOMAIN  default 'triibetalents.com'
//   ALLOWED_EMAILS        optional CSV of extra exact emails to allow
// Never uses the service_role key here.
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL  = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
export const AUTH_REQUIRED = (process.env.AUTH_REQUIRED ?? 'true') !== 'false';
const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'triibetalents.com').toLowerCase();
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

let _sb = null;
function sb() {
  if (!_sb) {
    if (!SUPABASE_URL || !SUPABASE_ANON) {
      throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY not set — cannot verify auth tokens');
    }
    _sb = createClient(SUPABASE_URL, SUPABASE_ANON, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _sb;
}

export function emailAllowed(email) {
  if (!email) return false;
  const e = email.toLowerCase();
  if (ALLOWED_EMAILS.includes(e)) return true;
  return e.endsWith('@' + ALLOWED_DOMAIN);
}

// Values safe to hand the browser so it can bootstrap the supabase-js client.
// The anon key is public by design; the service_role key is never included.
export function publicConfig() {
  return {
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON,
    allowedDomain: ALLOWED_DOMAIN,
    authRequired: AUTH_REQUIRED,
  };
}

// Small cache so we don't call the Supabase auth server on every API request.
const _cache = new Map(); // token -> { email, exp }
const TTL_MS = 60_000;

function bearer(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

// -> { ok:true, user } | { ok:false, status, error }
export async function checkAuth(req) {
  if (!AUTH_REQUIRED) return { ok: true, user: null };
  const token = bearer(req);
  if (!token) return { ok: false, status: 401, error: 'not signed in' };

  const cached = _cache.get(token);
  if (cached && cached.exp > Date.now()) {
    return emailAllowed(cached.email)
      ? { ok: true, user: { email: cached.email } }
      : { ok: false, status: 403, error: `only @${ALLOWED_DOMAIN} accounts allowed` };
  }

  let data, error;
  try { ({ data, error } = await sb().auth.getUser(token)); }
  catch { return { ok: false, status: 401, error: 'token verification failed' }; }

  const email = data?.user?.email;
  if (error || !email) return { ok: false, status: 401, error: 'invalid session' };

  _cache.set(token, { email, exp: Date.now() + TTL_MS });
  return emailAllowed(email)
    ? { ok: true, user: { email } }
    : { ok: false, status: 403, error: `only @${ALLOWED_DOMAIN} accounts allowed` };
}

// Paths reachable WITHOUT auth so the login screen can load and bootstrap.
export function isPublicPath(pathname) {
  if (pathname === '/api/public-config') return true; // browser bootstraps supabase-js from this
  if (pathname === '/api/health') return true;        // health checks
  if (!pathname.startsWith('/api/')) return true;      // SPA shell + static assets
  return false;
}
