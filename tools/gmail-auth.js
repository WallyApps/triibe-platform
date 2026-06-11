// One-time interactive Gmail OAuth setup.
// Run: `node tools/gmail-auth.js` (or `npm run gmail-auth`).
// Opens browser → you click Allow → token saved to credentials/token.json.
// After that, the server polls Gmail autonomously.
import { runAuthFlow, hasToken } from '../server/providers/inbound.gmail.js';

if (hasToken()) {
  console.log('✓ token.json already exists — Gmail is connected.');
  console.log('  To re-authorize, delete credentials/token.json and run this again.');
  process.exit(0);
}

console.log('Triibe Platform · Gmail OAuth setup');
console.log('-----------------------------------');

try {
  const tokens = await runAuthFlow();
  console.log('\n✓ Gmail connected.');
  console.log('  refresh_token:', tokens.refresh_token ? 'yes (autonomous refresh will work)' : '⚠ MISSING — re-run with prompt=consent to get one');
  console.log('  scopes:', tokens.scope);
  console.log('\nNext: restart the server (or hit ↻ Sync now in the platform) to pull fresh threads.');
} catch (e) {
  console.error('✗ OAuth flow failed:', e.message);
  process.exit(1);
}
