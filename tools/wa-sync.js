// Run the existing ~/triibe-ops/whatsapp-bridge/pull.js, then re-ingest the
// updated live.json into the platform DB.
//
// Usage:
//   node tools/wa-sync.js          # one-shot
//   node tools/wa-sync.js --daemon # loop every 5 minutes
//
// Reuses the authed session in ~/triibe-ops/whatsapp-bridge/.wwebjs_auth — no
// new QR scan needed as long as Riley's phone still has WhatsApp Web linked.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { openDb } from '../db/init.js';
import { ingestAll } from '../server/engines/ingest.js';

const BRIDGE_DIR = process.env.WA_BRIDGE_DIR || '/Users/rileywallack/triibe-ops/whatsapp-bridge';
const PULL_SCRIPT = `${BRIDGE_DIR}/pull.js`;
const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let _running = false;

async function runPull() {
  if (_running) { console.log('[wa-sync] already running, skipping'); return null; }
  if (!existsSync(PULL_SCRIPT)) {
    console.log(`[wa-sync] missing ${PULL_SCRIPT} — skipping`);
    return { ok: false, reason: 'bridge script missing' };
  }
  _running = true;
  const start = Date.now();
  console.log(`[wa-sync] ${new Date().toISOString()} pulling WhatsApp…`);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('node', [PULL_SCRIPT], { cwd: BRIDGE_DIR, stdio: 'inherit' });
      child.on('exit', code => code === 0 ? resolve() : reject(new Error('pull.js exit ' + code)));
      child.on('error', reject);
      // 90s timeout in case Chromium hangs
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('pull.js timeout 90s')); }, 90_000);
    });
    const ms = Date.now() - start;
    // Re-ingest. Schema is managed centrally (db/init.js / server boot); do NOT
    // re-init or close the shared pool here — runPull also runs in-process from
    // the server's 5-min interval, where closing the pool would break the server.
    const db = openDb();
    const stats = await ingestAll(db);
    console.log(`[wa-sync] ✓ pulled + ingested in ${(ms/1000).toFixed(1)}s — WA:`, stats.whatsapp);
    return { ok: true, ms, stats: stats.whatsapp };
  } catch (e) {
    console.warn(`[wa-sync] ✗ ${e.message}`);
    return { ok: false, reason: e.message };
  } finally {
    _running = false;
  }
}

export { runPull };

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const daemon = process.argv.includes('--daemon');
  await runPull();
  if (daemon) {
    console.log(`[wa-sync] daemon mode — every ${INTERVAL_MS/1000}s`);
    setInterval(() => { runPull().catch(()=>{}); }, INTERVAL_MS);
  } else {
    process.exit(0);
  }
}
