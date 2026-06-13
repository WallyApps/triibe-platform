// Vercel serverless adapter.
//
// Vercel hands each request to this default export with Node-compatible
// (req, res) objects. We reuse the app's own HTTP request handler verbatim, so
// every route the standalone server serves works here too. ensureInit() warms
// the config cache + runs idempotent migrations once per cold start (it caches
// its promise, so concurrent/subsequent invocations don't repeat the work).
//
// Importing ../server/index.js is side-effect-free (it only binds a port when
// run directly), so this never starts a second server or background intervals.
import { handleRequest } from '../server/index.js';
import { ensureInit } from '../server/providers/index.js';

export default async function handler(req, res) {
  await ensureInit();
  return handleRequest(req, res);
}
