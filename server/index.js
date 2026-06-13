// Triibe Platform — local HTTP server + JSON API.
// Zero npm deps (node:http + node:fs + node:sqlite). Runs on PORT (default 4744)
// — picked to NOT collide with your live dashboard (4711) or the mockup (4733).
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadEnv } from './env.js';
import { providers } from './providers/index.js';
import { computeClashes, canDo } from './engines/clash.js';
import { suggestPrice } from './engines/pricing.js';
import { checklistForDeal, antiMistakeReport, pickDraftMode, ITEMS as CHECKLIST_ITEMS } from './engines/checklist.js';
import { ingestAll } from './engines/ingest.js';
import { extractText, aiExtractTerms } from './engines/contract_extract.js';
import { promoteFromContract, promoteFromEmailSignal, undoPromotion,
         listActiveNotifications, dismissNotification, extractDollarCents } from './engines/auto_promote.js';
import { readFileSync as _readRateCard } from 'node:fs';
let RATE_CARD = {};
try { RATE_CARD = JSON.parse(_readRateCard('/Users/rileywallack/triibe-platform/config/rate_card.json', 'utf8')); } catch {}
import { writeFileSync, mkdirSync } from 'node:fs';
import { GmailInboundProvider, hasToken as hasGmailToken, sendThreadedReply, pullSingleThread, stripQuotedReply } from './providers/inbound.gmail.js';
import { runPull as runWhatsAppPull } from '../tools/wa-sync.js';
import { reconcileThreadStates } from './engines/reconcile.js';
import { computeCloseScore } from './engines/close_score.js';

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PUBLIC = join(ROOT, 'public');
const PORT = parseInt(process.env.PORT || '4744', 10);

// Lazy provider resolution — re-reads config every request so flipping
// `ai_enabled` is instant (no server restart needed).
let _P = providers();
const P = new Proxy({}, { get: (_, k) => {
  if (k === 'reload') return () => { _P = providers(); };
  return _P[k];
}});
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png',
  '.jpg':'image/jpeg', '.ico':'image/x-icon', '.webmanifest':'application/manifest+json' };

const send = (res, code, data, headers = {}) => {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(body);
};
const json = (res, data, code = 200) => send(res, code, data);
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });

const routes = [];
const route = (method, pat, handler) => routes.push({ method, re: new RegExp('^' + pat + '$'), handler });

// ---- API routes -------------------------------------------------------------

route('GET', '/api/health', async (req, res) => {
  const dcount = P.db().prepare('SELECT COUNT(*) c FROM deals').get().c;
  const spend = P.spend.status();
  json(res, { ok: true, deals: dcount, spend, providers: {
    data: 'sqlite', draft: P.cfg('draft_provider', 'local-stub'),
    ai_enabled: spend.enabled
  }});
});

route('GET', '/api/creators', async (req, res) => json(res, P.data.listCreators()));

route('GET', '/api/deals', async (req, res, { url }) => {
  const q = url.searchParams;
  json(res, P.data.listDeals({
    creator: q.get('creator') || undefined,
    funnel_stage: q.get('stage') || undefined,
    state: q.get('state') || undefined,
    focus: q.get('focus') === '1',
    limit: parseInt(q.get('limit') || '500', 10),
  }));
});

route('GET', '/api/deals/([^/]+)', async (req, res, { match }) => {
  const d = P.data.getDeal(match[1]);
  if (!d) return json(res, { error: 'not found' }, 404);
  json(res, d);
});

route('GET', '/api/funnel', async (req, res, { url }) => {
  json(res, P.data.funnelHealth({
    creator: url.searchParams.get('creator') || undefined,
    focus: url.searchParams.get('focus') === '1',
  }));
});

// --- PARKED DEALS ----------------------------------------------------------
// Deals on ice with a "come back later" date. When revisit_at <= today, the
// daily revival job (revivePastDueParked, called from /api/this-week + sync)
// flips them back to state=open with revived_at stamped so the UI can show a
// "REVIVED — last contact Xd ago" banner.

// Auto-revive any dormant deal whose revisit date is today-or-past. Cheap query,
// idempotent — safe to call on every Pitches/Today refresh.
function revivePastDueParked(db) {
  const todayISO = new Date().toISOString().slice(0, 10);
  return db.prepare(`
    UPDATE deals
       SET state = 'open',
           revived_at = datetime('now'),
           updated_at = datetime('now')
     WHERE state = 'dormant'
       AND revisit_at IS NOT NULL
       AND revisit_at <= ?
  `).run(todayISO).changes;
}

route('GET', '/api/parked', async (req, res, { url }) => {
  const creator = url.searchParams.get('creator') || undefined;
  // Run revival first so anything past-due drops OUT of this list and shows up
  // in Pitches with the revived banner on the next refresh.
  try { revivePastDueParked(P.db()); } catch {}
  const rows = P.db().prepare(`
    SELECT id, brand, creator_id, fee_cents, raw_stage, category,
           parked_at, revisit_at, park_reason,
           last_activity_at, ai_summary, next_action_detail
      FROM deals
     WHERE state = 'dormant'
       ${creator ? 'AND creator_id = ?' : ''}
     ORDER BY revisit_at ASC NULLS LAST, parked_at DESC
  `).all(...(creator ? [creator] : []));
  // For each parked deal, attach the last brand message snippet so the UI can
  // show context even when ai_summary hasn't been generated yet (the legacy
  // dormant deals from before the Park feature don't have summaries on file).
  const lastMsgStmt = P.db().prepare(`
    SELECT m.body, m.snippet, m.sent_at, m.channel, m.from_us, m.sender
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE t.deal_id = ?
    ORDER BY m.sent_at DESC LIMIT 1
  `);
  // Compute days-until-revisit for the UI so it can render "in 12d" / "overdue 3d".
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const enriched = rows.map(r => {
    let days_until = null;
    if (r.revisit_at) {
      const t = new Date(r.revisit_at + 'T00:00:00Z').getTime();
      days_until = Math.round((t - today.getTime()) / 86400000);
    }
    // Pull the most recent message on the deal's thread; strip quoted email
    // reply chains so we don't show stale text from a previous round.
    const m = lastMsgStmt.get(r.id);
    let last_msg = null;
    if (m) {
      let body = m.body || m.snippet || '';
      if (m.channel === 'email' && body) {
        try { body = stripQuotedReply(body) || body; } catch {}
      }
      body = body.replace(/\s+/g, ' ').trim();
      if (body.length > 240) body = body.slice(0, 240).replace(/\s\S*$/, '') + '…';
      last_msg = {
        text: body,
        from: m.from_us ? 'us' : (m.sender || 'brand'),
        channel: m.channel,
        sent_at: m.sent_at,
      };
    }
    return { ...r, days_until_revisit: days_until, last_msg };
  });
  json(res, { parked: enriched, count: enriched.length });
});

// Park a deal — state→dormant, set revisit_at (defaults 60 days out) + reason.
// Body: { revisit_at?: 'YYYY-MM-DD' | null, reason?: string, days_out?: number }
// If neither revisit_at nor days_out is given, default to 60 days from today.
route('POST', '/api/deals/([^/]+)/park', async (req, res, { match }) => {
  const dealId = match[1];
  const deal = P.data.getDeal(dealId);
  if (!deal) return json(res, { error: 'not found' }, 404);
  let body = {};
  try { body = JSON.parse(await readBody(req) || '{}'); } catch {}
  let revisitAt = body.revisit_at;
  if (!revisitAt) {
    const daysOut = Number.isFinite(body.days_out) ? body.days_out : 60;
    const d = new Date();
    d.setDate(d.getDate() + daysOut);
    revisitAt = d.toISOString().slice(0, 10);
  }
  const reason = (body.reason || '').slice(0, 280) || null;
  P.db().prepare(`
    UPDATE deals
       SET state = 'dormant',
           revisit_at = ?,
           park_reason = ?,
           parked_at = datetime('now'),
           revived_at = NULL,
           updated_at = datetime('now')
     WHERE id = ?
  `).run(revisitAt, reason, dealId);
  json(res, { ok: true, deal_id: dealId, revisit_at: revisitAt, park_reason: reason });
});

// Unpark — bring a deal back to active pipeline manually (Riley clicked
// "Reach out now"). Clears revisit fields so it behaves like a normal open deal.
route('POST', '/api/deals/([^/]+)/unpark', async (req, res, { match }) => {
  const dealId = match[1];
  const deal = P.data.getDeal(dealId);
  if (!deal) return json(res, { error: 'not found' }, 404);
  P.db().prepare(`
    UPDATE deals
       SET state = 'open',
           revisit_at = NULL,
           parked_at = NULL,
           revived_at = datetime('now'),
           updated_at = datetime('now')
     WHERE id = ?
  `).run(dealId);
  json(res, { ok: true, deal_id: dealId });
});

// Pipeline snapshot — one-line answer to "what deals do I have right now"
// Used by the banner at the top of Today. Cheap aggregation.
route('GET', '/api/pipeline-snapshot', async (req, res, { url }) => {
  const creator = url.searchParams.get('creator');
  if (!creator) return json(res, {});
  // Reuse the canonical sources of truth so counts always match the tabs
  try {
    const [twRes, fuRes, ibRes, ipRes] = await Promise.all([
      fetch(`http://localhost:${PORT}/api/this-week?creator=${encodeURIComponent(creator)}`),
      fetch(`http://localhost:${PORT}/api/follow-ups?creator=${encodeURIComponent(creator)}`),
      fetch(`http://localhost:${PORT}/api/inbox?creator=${encodeURIComponent(creator)}&filter=needs-reply`),
      fetch(`http://localhost:${PORT}/api/inbox-pitches`),
    ]);
    const tw = await twRes.json();
    const fu = await fuRes.json();
    const ib = await ibRes.json();
    const ip = await ipRes.json();
    const confirmed = tw.deals || [];
    const closeable = tw.pending || [];
    const confirmedValue = confirmed.reduce((s, d) => s + (d.fee_cents || 0), 0);
    const closeableValue = closeable.reduce((s, d) => s + (d.fee_cents || 0), 0);
    const pitches = (ip || []).filter(p =>
      !p.creator_guess || p.creator_guess === creator || p.creator_guess === 'unknown'
    );
    json(res, {
      creator,
      confirmed: { count: confirmed.length, value_cents: confirmedValue },
      closeable: { count: closeable.length, value_cents: closeableValue },
      followups: { count: fu.length },
      needs_reply: { count: ib.length },
      pitches:    { count: pitches.length },
    });
  } catch (e) {
    json(res, { error: e.message });
  }
});

route('GET', '/api/money', async (req, res, { url }) => {
  json(res, P.data.moneySummary({ creator: url.searchParams.get('creator') || undefined }));
});

// Morning Brief: the "what fires today" hero. Three sections:
//   - todo: top 5-7 actionable items ranked by urgency (red→amber→green)
//   - done_today: recent outbound (last 24h) so Riley sees what he's done
//   - needs_eyes: brand inbound waiting on him (last 36h, ball-on-us)
// Reuses /api/this-week data but re-orders for hero presentation.
route('GET', '/api/morning-brief', async (req, res, { url }) => {
  const creator = url.searchParams.get('creator') || 'cooper';
  try {
    // Pull the canonical this-week data — it already has actions + last_outbound
    const twRes = await fetch(`http://localhost:${PORT}/api/this-week?creator=${encodeURIComponent(creator)}`);
    const tw = await twRes.json();
    const all = [...(tw.deals || []), ...(tw.pending || [])];

    // TODO LIST: extract every open (not-completed) action across all deals,
    // tagged with the deal's brand + fee + urgency tier.
    //
    // CRITICAL FILTER: if Riley has acted on a deal in the last 12h, suppress
    // ALL its open actions. The action checklist is its own state and doesn't
    // know that he just emailed/whatsapped the brand. Without this filter the
    // brief shows "Check in with John about GoMarble" RIGHT AFTER he just
    // nudged John, which makes the platform look dumb.
    //
    // Non-communication action kinds (post, sign, deliver, film, invoice)
    // stay even with recent outbound because those are independent tasks.
    const tierRank = { red: 0, amber: 1, green: 2, blue: 3 };
    const PRODUCTION_KINDS = new Set(['post','sign','deliver','film','upload_raw','invoice','submit','submit_concept','submit_draft','script','review','approval','revision']);
    const todoRaw = [];
    const suppressedDeals = [];
    for (const d of all) {
      const actedRecently = d.last_outbound && d.last_outbound.age_hours != null && d.last_outbound.age_hours < 24;
      const paymentInFlight = !!d.payment_in_flight;
      for (const a of (d.actions || [])) {
        if (a.completed) continue;
        const isProductionTask = PRODUCTION_KINDS.has((a.kind || '').toLowerCase());
        const kindLower = (a.kind || '').toLowerCase();
        const isPaymentAction = kindLower.includes('payment') || kindLower.includes('invoice')
                              || /chase payment|pay|invoice/i.test(a.label || '');
        // Suppress payment actions when payment is already routed via Lumanu/Wise/etc.
        if (paymentInFlight && isPaymentAction) {
          suppressedDeals.push({ deal_id: d.deal_id, brand: d.brand, action_label: a.label, reason: 'payment_in_flight' });
          continue;
        }
        // Suppress communication-type actions if Riley acted recently
        if (actedRecently && !isProductionTask) {
          suppressedDeals.push({ deal_id: d.deal_id, brand: d.brand, action_label: a.label, reason: 'acted_recently' });
          continue;
        }
        todoRaw.push({
          deal_id: d.deal_id,
          brand: d.brand,
          fee_cents: d.fee_cents,
          posting_date: d.posting_date,
          funnel_stage: d.funnel_stage,
          state: d.state,
          action_kind: a.kind,
          action_label: a.label,
          action_detail: a.detail,
          action_tier: a.tier || 'green',
          action_date_label: a.date_label,
        });
      }
    }
    // Sort: tier first, then by fee descending (bigger deals surface earlier)
    todoRaw.sort((a, b) => {
      const t = (tierRank[a.action_tier] ?? 9) - (tierRank[b.action_tier] ?? 9);
      if (t !== 0) return t;
      return (b.fee_cents || 0) - (a.fee_cents || 0);
    });
    // Cap at top 8 so the brief doesn't sprawl
    const todo = todoRaw.slice(0, 8);

    // DONE TODAY: from last_outbound enrichment, filter to <24h
    const doneToday = all
      .filter(d => d.last_outbound && d.last_outbound.age_hours != null && d.last_outbound.age_hours < 24)
      .map(d => ({
        deal_id: d.deal_id,
        brand: d.brand,
        fee_cents: d.fee_cents,
        kind: d.last_outbound.kind,
        channel: d.last_outbound.channel,
        age_hours: d.last_outbound.age_hours,
      }))
      .sort((a, b) => (a.age_hours || 0) - (b.age_hours || 0));

    // NEEDS EYES: brand replies waiting on us, last 36h, not yet acknowledged
    const needsEyes = all
      .filter(d => d.unread_reply && !d.last_outbound)  // brand replied + we haven't responded
      .map(d => ({
        deal_id: d.deal_id,
        brand: d.brand,
        fee_cents: d.fee_cents,
        sender: d.unread_reply.sender,
        channel: d.unread_reply.channel,
        age_hours: d.unread_reply.age_hours,
      }))
      .sort((a, b) => (a.age_hours || 0) - (b.age_hours || 0));

    json(res, {
      creator,
      todo,
      done_today: doneToday,
      needs_eyes: needsEyes,
      counts: {
        todo: todo.length,
        done_today: doneToday.length,
        needs_eyes: needsEyes.length,
      },
    });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

// Money Pulse: monthly target progress + chase queue. Drives the homepage target
// meter + the "stop quiet pipeline from rotting" auto-section. Target is $15K
// per creator (configurable via cfg('target_monthly_cents_{creator}')). Chase
// queue = deals with real $ that are quiet enough to be at risk.
// Rolling-90d strategic forecast for a creator. Returns the sequenced plan
// (top-EV pending deals assigned to open posting slots), weekly slot grid,
// monthly buckets, and historical-blended close-rate scores per pending deal.
// Cached in-process for 5 min so repeat hits don't re-fit the close-rate
// table; /api/sync warms the cache.
const FORECAST_CACHE = new Map(); // creator -> { forecast, ts }
const FORECAST_TTL_MS = 5 * 60 * 1000;
async function computeForecast(creator) {
  const m = await import('./engines/forecaster.js');
  return m.forecast(P.db(), creator);
}
route('GET', '/api/forecast', async (req, res, { url }) => {
  const creator = url.searchParams.get('creator') || 'cooper';
  const force   = url.searchParams.get('force') === '1';
  const cached  = FORECAST_CACHE.get(creator);
  if (!force && cached && (Date.now() - cached.ts) < FORECAST_TTL_MS) {
    return json(res, { ...cached.forecast, cached: true });
  }
  try {
    const forecast = await computeForecast(creator);
    FORECAST_CACHE.set(creator, { forecast, ts: Date.now() });
    json(res, { ...forecast, cached: false });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

route('GET', '/api/money-pulse', async (req, res, { url }) => {
  const creator = url.searchParams.get('creator') || 'cooper';
  const targetCents = parseInt(P.cfg(`target_monthly_cents_${creator}`, '1500000'), 10);

  // Booked this month = locked/won deals with a posting_date OR posting_window
  // landing in the current calendar month. We anchor on posting_date because
  // that's when the money actually counts toward the month's pace.
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const monthEnd = new Date(monthStart); monthEnd.setMonth(monthEnd.getMonth()+1);
  const monthStartIso = monthStart.toISOString().slice(0,10);
  const monthEndIso = monthEnd.toISOString().slice(0,10);

  const booked = P.db().prepare(`
    SELECT id, brand, fee_cents, posting_date, posting_window_start, funnel_stage, state
    FROM deals
    WHERE creator_id = ?
      AND fee_cents IS NOT NULL AND fee_cents > 0
      AND (state = 'won' OR funnel_stage IN ('in_works','signed','agreed'))
      AND COALESCE(posting_date, posting_window_start) >= ?
      AND COALESCE(posting_date, posting_window_start) < ?
    ORDER BY COALESCE(posting_date, posting_window_start)
  `).all(creator, monthStartIso, monthEndIso);

  const bookedCents = booked.reduce((s, d) => s + (d.fee_cents || 0), 0);

  // Projected = booked + (high-likelihood-to-close deals' fees × 50% probability
  // adjustment). High likelihood = brand has counter-engaged + we've got real
  // numbers + ball is moving. Use last_activity_at within 7 days as proxy.
  const projected = P.db().prepare(`
    SELECT id, brand, fee_cents, ball_in_court, last_activity_at, last_activity_by, funnel_stage
    FROM deals
    WHERE creator_id = ?
      AND fee_cents IS NOT NULL AND fee_cents > 0
      AND state = 'open'
      AND funnel_stage IN ('pitching','conversation')
      AND last_activity_at > datetime('now', '-14 days')
  `).all(creator);

  // Likelihood: 0.5 if ball is on brand (they've engaged & we're waiting),
  // 0.3 if ball is on us (we're still working it), 0.15 otherwise.
  const projectedCents = projected.reduce((s, d) => {
    const weight = d.ball_in_court === 'brand' ? 0.5
                : d.ball_in_court === 'us' ? 0.3 : 0.15;
    return s + Math.round((d.fee_cents || 0) * weight);
  }, 0);

  const totalProjectedCents = bookedCents + projectedCents;
  const pct = Math.min(100, Math.round((bookedCents / targetCents) * 100));
  const projectedPct = Math.min(100, Math.round((totalProjectedCents / targetCents) * 100));

  // Days elapsed in month (for pace-aware coloring)
  const today = new Date();
  const dayOfMonth = today.getDate();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate();
  const expectedPct = Math.round((dayOfMonth / daysInMonth) * 100);

  // Tone: green if on/ahead of pace, amber if near pace, red if behind
  let tone = 'red';
  if (pct >= expectedPct - 5) tone = 'green';
  else if (pct >= expectedPct - 20) tone = 'amber';

  // Chase queue: real-$ deals that are at risk of going cold. Two flavors:
  //   1. Ball on us, days quiet > 4 (we're dropping the ball)
  //   2. Ball on brand, days quiet 5-21 (they're stalling, need a nudge)
  // Exclude already-locked deals (in_works/signed). Sort by fee DESC.
  const chase = P.db().prepare(`
    SELECT d.id, d.brand, d.contact_name, d.fee_cents, d.ball_in_court, d.last_activity_at,
           d.last_activity_by, d.funnel_stage, d.thread_id,
           ROUND(julianday('now') - julianday(d.last_activity_at), 1) as days_quiet,
           (SELECT classification FROM messages m
            WHERE m.thread_id IN (SELECT id FROM threads WHERE deal_id = d.id)
              AND m.from_us = 0 ORDER BY m.sent_at DESC LIMIT 1) as last_brand_class
    FROM deals d
    WHERE d.creator_id = ?
      AND d.fee_cents IS NOT NULL AND d.fee_cents >= 100000
      AND d.state = 'open'
      AND d.funnel_stage IN ('pitching','conversation')
      AND d.last_activity_at > datetime('now', '-30 days')
      AND (
        (d.ball_in_court IN ('us','riley') AND julianday('now') - julianday(d.last_activity_at) >= 4)
        OR
        (d.ball_in_court = 'brand' AND julianday('now') - julianday(d.last_activity_at) BETWEEN 5 AND 21)
      )
    ORDER BY d.fee_cents DESC, d.last_activity_at ASC
    LIMIT 10
  `).all(creator);

  const chaseValueCents = chase.reduce((s, d) => s + (d.fee_cents || 0), 0);
  const chaseRows = chase.map(d => ({
    id: d.id, brand: d.brand, contact_name: d.contact_name,
    fee_cents: d.fee_cents,
    ball_in_court: d.ball_in_court,
    days_quiet: Math.floor(d.days_quiet || 0),
    last_activity_at: d.last_activity_at,
    urgency: d.ball_in_court === 'us' ? 'we owe reply' : 'brand stalled',
  }));

  json(res, {
    creator,
    target_cents: targetCents,
    booked_cents: bookedCents,
    booked_count: booked.length,
    projected_cents: totalProjectedCents,
    projected_addition_cents: projectedCents,
    pct, projected_pct: projectedPct, expected_pct: expectedPct, tone,
    month_label: today.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
    chase: chaseRows,
    chase_value_cents: chaseValueCents,
  });
});

// Detailed money view: invoices owed + recently collected for the Money tab.
route('GET', '/api/money/detail', async (req, res, { url }) => {
  const creator = url.searchParams.get('creator');
  const filter = creator ? 'AND d.creator_id = ?' : '';
  const args = creator ? [creator] : [];

  // Invoices owed = booked deals with fee_cents > 0 and no paid payment yet.
  // Use posting_date (or delivery date) as the "anchor" for net-30 aging.
  const BOOKED_RAW = "('contract_received','contract_signed','signed','in_revision','in_production','confirmed')";
  const owed = P.db().prepare(`
    SELECT d.id, d.brand, d.creator_id, d.fee_cents, d.posting_date,
           d.last_activity_at, d.funnel_stage, d.state, d.raw_stage, d.flags
    FROM deals d
    WHERE d.state != 'lost'
      AND d.fee_cents IS NOT NULL AND d.fee_cents > 0
      AND (d.state = 'won' OR (d.funnel_stage IN ('in_works','active') AND d.raw_stage IN ${BOOKED_RAW}))
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.deal_id = d.id AND p.status = 'paid')
      ${filter}
    ORDER BY d.fee_cents DESC`).all(...args);

  // Pull latest brand-msg classification per deal to detect payment-in-flight
  // (e.g. "sent payment via Lumanu" → don't show "on track", show "via Lumanu").
  const ownedIds = owed.map(d => d.id);
  const paymentRouting = {};
  if (ownedIds.length) {
    const ph = ownedIds.map(() => '?').join(',');
    const rows = P.db().prepare(`
      SELECT t.deal_id,
             (SELECT m.classification FROM messages m WHERE m.thread_id=t.id AND m.from_us=0
              ORDER BY m.sent_at DESC LIMIT 1) AS cls,
             (SELECT m.body FROM messages m WHERE m.thread_id=t.id AND m.from_us=0
              ORDER BY m.sent_at DESC LIMIT 1) AS body
      FROM threads t WHERE t.deal_id IN (${ph})
        AND t.last_message_at = (
          SELECT MAX(t2.last_message_at) FROM threads t2 WHERE t2.deal_id = t.deal_id
        )`).all(...ownedIds);
    for (const r of rows) {
      let cls = null;
      try { cls = r.cls ? JSON.parse(r.cls) : null; } catch {}
      const body = (r.body || '').toLowerCase();
      if (cls && cls.action_type === 'payment_chase'
          && /(lumanu|wise|payoneer|stripe|tipalti|paid via|payout|invoice (sent|processed|received|approved)|payment details)/i.test(body)) {
        const platform = /lumanu/i.test(body) ? 'Lumanu'
                       : /wise/i.test(body) ? 'Wise'
                       : /payoneer/i.test(body) ? 'Payoneer'
                       : /stripe/i.test(body) ? 'Stripe'
                       : /tipalti/i.test(body) ? 'Tipalti'
                       : 'platform';
        paymentRouting[r.deal_id] = platform;
      }
    }
  }

  // Compute age / status per invoice (net-30 default).
  const todayMs = Date.now();
  const owedRows = owed.map(d => {
    // Anchor for aging = posting_date if set, else last_activity_at, else null
    const anchorIso = d.posting_date || d.last_activity_at;
    const ageDays = anchorIso
      ? Math.floor((todayMs - new Date(anchorIso).getTime()) / 86400000)
      : null;
    let status = 'on track';
    let payment_via = paymentRouting[d.id] || null;
    if (payment_via) {
      // Payment routed through an external platform — Riley needs to withdraw
      // from there, not chase the brand. Override aging-based status.
      status = `via ${payment_via}`;
    } else if (ageDays !== null) {
      if (ageDays > 40)      status = 'escalate';
      else if (ageDays > 30) status = 'overdue';
      else if (ageDays > 25) status = 'net-30 due';
    } else if (d.state === 'won') {
      status = 'awaiting posting date';
    } else {
      status = d.raw_stage ? d.raw_stage.replace(/_/g,' ') : 'pre-invoice';
    }
    return { id: d.id, brand: d.brand, creator_id: d.creator_id,
             fee_cents: d.fee_cents, age_days: ageDays, status, payment_via,
             anchor: anchorIso ? anchorIso.slice(0,10) : null };
  });

  // Recently collected = paid payments, latest first.
  const recentCreatorClause = creator ? 'AND p.deal_id IN (SELECT id FROM deals WHERE creator_id=?)' : '';
  const collected = P.db().prepare(`
    SELECT p.deal_id, p.amount_cents, p.paid_at, p.split_creator_cents, p.split_riley_cents,
           p.split_house_cents, d.brand
    FROM payments p JOIN deals d ON d.id = p.deal_id
    WHERE p.status = 'paid' ${recentCreatorClause}
    ORDER BY p.paid_at DESC LIMIT 10`).all(...(creator ? [creator] : []));

  json(res, { owed: owedRows, collected });
});

route('GET', '/api/today', async (req, res, { url }) => {
  json(res, P.data.todayActions({
    creator: url.searchParams.get('creator') || undefined,
    focus: url.searchParams.get('focus') === '1',
    limit: 12,
  }));
});

route('GET', '/api/clashes', async (req, res) => {
  const deals = P.data.listDeals({ state: 'open', limit: 2000 });
  json(res, computeClashes(deals));
});

// Threads list — for the Threads tab. One row per thread with the latest
// message snippet + deal info + draft-ready flag.
route('GET', '/api/threads', async (req, res, { url }) => {
  const creator = url.searchParams.get('creator');
  const filter = creator ? 'AND d.creator_id = ?' : '';
  const args = creator ? [creator] : [];
  // For each thread with a deal_id, pull: thread metadata + the newest message + draft count
  const rows = P.db().prepare(`
    SELECT t.id, t.deal_id, t.channel, t.subject, t.last_message_at,
           t.last_message_by, t.ball_in_court,
           d.brand, d.creator_id, d.fee_cents, d.funnel_stage,
           (SELECT body FROM messages WHERE thread_id = t.id ORDER BY sent_at DESC LIMIT 1) AS last_body,
           (SELECT snippet FROM messages WHERE thread_id = t.id ORDER BY sent_at DESC LIMIT 1) AS last_snippet,
           (SELECT sender FROM messages WHERE thread_id = t.id AND from_us=0 ORDER BY sent_at DESC LIMIT 1) AS last_brand_sender,
           (SELECT COUNT(*) FROM drafts WHERE thread_id = t.id AND status='ready') AS drafts_ready
    FROM threads t
    LEFT JOIN deals d ON d.id = t.deal_id
    WHERE t.deal_id IS NOT NULL ${filter}
    ORDER BY t.last_message_at DESC
    LIMIT 200`).all(...args);
  json(res, rows);
});

// Force-refresh a single deal's primary email thread (full bodies + attachments).
// Used when a pill expands and the cached body is empty — self-heals stale syncs.
route('POST', '/api/deals/([^/]+)/refresh-thread', async (req, res, { match }) => {
  const deal = P.data.getDeal(match[1]);
  if (!deal) return json(res, { ok:false, reason:'not found' }, 404);
  if (!deal.thread_id) return json(res, { ok:false, reason:'no thread linked' });
  try {
    const r = await pullSingleThread(P.db(), deal.thread_id);
    json(res, { ok:true, ...r });
  } catch (e) {
    json(res, { ok:false, reason: e.message }, 500);
  }
});

// Full conversation for a deal — last N messages across all linked threads,
// both directions, quoted reply chains stripped, oldest→newest. Used by the
// pill expanded view so Riley sees what he sent too, not just brand replies.
route('GET', '/api/deals/([^/]+)/conversation', async (req, res, { match, url }) => {
  const dealId = match[1];
  const limit = Math.min(Number(url.searchParams.get('limit') || 8), 30);
  const msgs = P.db().prepare(`
    SELECT m.id, m.thread_id, m.channel, m.sender, m.from_us, m.sent_at,
           m.snippet, m.body, t.subject
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE t.deal_id = ?
    ORDER BY m.sent_at DESC LIMIT ?`).all(dealId, limit);
  // Clean each message: strip quoted chain on email, fallback to snippet if body empty
  const cleaned = msgs.map(m => {
    let body = m.body;
    if (m.channel === 'email' && body) body = stripQuotedReply(body);
    if (!body || body.length < 5) body = m.snippet || body;
    return {
      id: m.id, thread_id: m.thread_id, channel: m.channel,
      sender: m.sender, from_us: !!m.from_us,
      sent_at: m.sent_at,
      body,
    };
  }).reverse();  // oldest → newest for the UI
  // Self-heal: if any email message has no body, refresh that thread fresh
  const empties = cleaned.filter(m => m.channel === 'email' && (!m.body || m.body.length < 5));
  if (empties.length) {
    const threadIds = [...new Set(empties.map(m => m.thread_id))];
    await Promise.all(threadIds.slice(0, 3).map(tid => pullSingleThread(P.db(), tid).catch(()=>{})));
    // refetch
    const refetched = P.db().prepare(`SELECT id, body FROM messages WHERE id IN (${cleaned.map(()=>'?').join(',')})`).all(...cleaned.map(c => c.id));
    const map = Object.fromEntries(refetched.map(r => [r.id, r.body]));
    for (const c of cleaned) {
      if (map[c.id]) {
        let b = map[c.id];
        if (c.channel === 'email') b = stripQuotedReply(b);
        if (b && b.length > 5) c.body = b;
      }
    }
  }
  json(res, { messages: cleaned, count: cleaned.length });
});

// Latest message per deal — returns both:
//   latest_overall  : the newest message in the thread (any direction)
//   latest_brand    : the newest message from the brand (for preview snippet)
// The UI uses latest_overall.from_us to decide whether to show "Draft reply".
route('GET', '/api/messages/latest', async (req, res, { url }) => {
  const ids = (url.searchParams.get('deals') || '').split(',').filter(Boolean);
  if (!ids.length) return json(res, []);
  const placeholders = ids.map(() => '?').join(',');
  // Newest overall (any direction)
  const overall = P.db().prepare(`
    SELECT t.deal_id, m.id, m.thread_id, m.channel, m.sender, m.from_us, m.sent_at,
           m.snippet, m.body
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE t.deal_id IN (${placeholders})
    GROUP BY t.deal_id HAVING MAX(m.sent_at)`).all(...ids);
  // Newest brand message (from_us=0)
  const brand = P.db().prepare(`
    SELECT t.deal_id, m.id, m.thread_id, m.channel, m.sender, m.from_us, m.sent_at,
           m.snippet, m.body
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE t.deal_id IN (${placeholders}) AND m.from_us = 0
    GROUP BY t.deal_id HAVING MAX(m.sent_at)`).all(...ids);
  // Strip quoted reply chains (Gmail bodies include the entire thread quoted
  // under each message). For email channel only — WA bodies are already clean.
  const cleanBody = (r) => {
    if (!r) return r;
    if (r.channel === 'email' && r.body) r.body = stripQuotedReply(r.body);
    // Fallback: if body became empty after stripping (or was empty already),
    // surface the snippet so the preview isn't blank.
    if (!r.body || r.body.length < 5) r.body = r.snippet || r.body;
    return r;
  };
  // Combine
  const out = {};
  for (const r of overall) out[r.deal_id] = { latest_overall: cleanBody(r), latest_brand: null };
  for (const r of brand) {
    out[r.deal_id] = out[r.deal_id] || { latest_overall: null, latest_brand: null };
    out[r.deal_id].latest_brand = cleanBody(r);
  }
  json(res, Object.entries(out).map(([deal_id, v]) => ({ deal_id, ...v })));
});

// Plain-English "where we are" summary per deal — AI-generated, aggressively cached.
// Regenerates only when deal.last_activity_at changes (so cost stays tiny).
route('GET', '/api/deals/([^/]+)/summary', async (req, res, { match, url }) => {
  const deal = P.data.getDeal(match[1]);
  if (!deal) return json(res, { error:'not found' }, 404);
  const force = url.searchParams.get('force') === '1';

  // Cached?
  if (!force && deal.ai_summary && deal.ai_summary_for === (deal.last_activity_at || ''))
    return json(res, { summary: deal.ai_summary, cached: true, at: deal.ai_summary_at });

  const apiKey = process.env.OPENAI_API_KEY;
  const aiEnabled = P.cfg('ai_enabled','false') === 'true' && apiKey;
  if (!aiEnabled) return json(res, { summary: deal.next_action || '', cached:false, ai:false });

  // Pull recent context: last 8 messages from the deal's threads (any channel).
  // 8 not 6 so we catch multi-round back-and-forth on rate negotiations.
  const recent = P.db().prepare(`
    SELECT m.channel, m.sender, m.from_us, m.sent_at, m.body, m.snippet
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE t.deal_id = ?
    ORDER BY m.sent_at DESC LIMIT 8`).all(deal.id).reverse();

  // Strip Gmail quoted-reply chains BEFORE passing bodies to the AI — otherwise
  // each brand reply carries Riley's prior outbound underneath, and the AI
  // anchors on stale text inside the quote block.
  const cleanBody = (m) => {
    let body = m.body || m.snippet || '';
    if (m.channel === 'email' && body) {
      try { body = stripQuotedReply(body) || body; } catch {}
    }
    return body.replace(/\s+/g, ' ').slice(0, 400);
  };

  // Also pull recent messages from the INTERNAL creator chat (COOPER X TRIIBE
  // / CHARLIE X TRIIBE) — these aren't linked to a deal_id but often contain
  // the real ground-truth status ("okay bet will have this done today" =
  // creator hasn't delivered yet, even though brand thread looks like we
  // already sent it).
  let creatorChat = [];
  if (deal.creator_id) {
    const chatRe = `%${deal.creator_id.toUpperCase()} X TRIIBE%`;
    creatorChat = P.db().prepare(`
      SELECT m.sender, m.from_us, m.sent_at, m.body, m.snippet
      FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE t.channel='whatsapp' AND t.subject LIKE ?
      ORDER BY m.sent_at DESC LIMIT 8`).all(chatRe).reverse();
  }

  // Identify the LAST brand message — the summary MUST anchor on its actual
  // content rather than parroting stale next_action_detail or generic
  // "waiting on brand" templates.
  const lastBrandMsg = [...recent].reverse().find(m => !m.from_us) || null;
  const lastOurMsg   = [...recent].reverse().find(m => m.from_us) || null;
  const brandIsMostRecent = !!(lastBrandMsg && (!lastOurMsg || lastBrandMsg.sent_at > lastOurMsg.sent_at));

  // Blank stale next_action_detail when it predates the latest brand reply.
  // Otherwise the AI weights "brand responded positively, sent terms" (written
  // a week ago by the auto-tagger) over what the brand actually just said.
  const noteDateMatch = (deal.next_action_detail || '').match(/\[(\d{1,2})\/(\d{1,2})\]/);
  let noteIsStale = false;
  if (noteDateMatch && lastBrandMsg) {
    const [, mm, dd] = noteDateMatch;
    const noteDay = `2026-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
    if (lastBrandMsg.sent_at.slice(0,10) > noteDay) noteIsStale = true;
  } else if (deal.ai_summary_for && lastBrandMsg && lastBrandMsg.sent_at > deal.ai_summary_for) {
    // Different fingerprint than what the note was written against → stale.
    noteIsStale = true;
  }
  const rileyNote = noteIsStale ? '(prior note suppressed — predates latest brand reply)'
                                : (deal.next_action_detail || deal.next_action || '').slice(0, 400);

  const sys = `Summarize where this brand partnership stands in 1-2 short sentences. PLAIN ENGLISH, conversational, like updating a teammate at the coffee machine.

THE LAST BRAND MESSAGE IS YOUR ANCHOR. Read it carefully and base the summary on what it actually says — not on stale notes, not on generic "waiting" templates.

First, classify the LAST BRAND MESSAGE stance into one of:
  - accepted: brand agreed to terms / signed off / approved
  - countered: brand proposed a different number or terms
  - declined_price: brand passing because rate is too high
  - declined_timing: brand passing because of dates / posting window
  - declined_other: brand passing for scope / fit / internal reasons
  - asking_for_info: brand needs deliverables, codes, contract info, or clarification from us
  - giving_feedback: brand sent edits / revisions / approval-with-changes
  - silent_no_reply: there is no brand response after our last outbound

Then write the summary. RULES:
  - DEAL STATE IS GROUND TRUTH. Before reading thread evidence, check state + raw_stage:
      - state=won + raw_stage=signed/contract_signed/contract_received → the deal IS CLOSED. NEVER say "waiting for signature" or "needs to sign". Describe what's next (script, draft, post, payment routing) based on the latest creator chat + brand thread.
      - state=lost → the deal is dead, don't suggest action.
      - state=open + funnel_stage=in_works/active → fulfillment phase; surface the specific deliverable owed (script, draft, post date, invoice).
  - CREATOR CHAT IS AUTHORITATIVE for delivery, signing, and payment confirmations. If Cooper or Charlie tells Riley "Sintra signed" / "filming today" / "got the wire from Lumanu", that overrides the brand thread (which may not have caught up yet).
  - PAYMENT routing via Lumanu / Wise / Payoneer = deal is essentially DONE, just waiting for clearance. Say "payment routing via Lumanu, just waiting for it to clear" — don't say "need to finalize content" if creator already delivered.
  - If brand is the most recent sender, NEVER say "we haven't heard back" / "still waiting on brand" / "no response yet". You MUST reflect what they actually said.
  - If brand declined on timing or scope, say that explicitly and what they offered for future ("wants to stay in touch when calendar opens").
  - If brand accepted but ball is now on us for the next step, name what we owe (script / contract / payment info / brief reply).
  - If brand is genuinely silent and only Riley's nudge is recent, say "you nudged on <date>, no reply yet".
  - Use the contact's first name when relevant.
  - NO lists, headings, emojis. NO third-person "Riley".

GOOD EXAMPLES:
"Lea passed on this round — the rate's fine but Cooper's July dates were too late for the campaign. She wants to stay in touch when his calendar opens back up."
"Keyshe approved the script with one small edit and the draft is in MiniMax's hands for review. Ball's on them now."
"Wilhelm is good on the recut you sent Jun 8 — he asked for the caption and hashtags, which still need to go over."
"Higgsfield's agency hasn't replied since your Jun 3 nudge with the July 13 anchor. Worth one more push."
"Mamita took the $6,000 counter back to Higgsfield for internal sign-off on May 26 — still no word. Time to nudge."`;

  const flagsList = (deal.flags || []).filter(f => /jun|jul|may|sent|received|signed|paid|delivered|pending|done|confirmed/.test(f)).slice(-8).join(', ');
  const lastBrandLine = lastBrandMsg
    ? `[${(lastBrandMsg.sent_at||'').slice(0,16).replace('T',' ')}] (${lastBrandMsg.channel}) ${lastBrandMsg.sender?.split('<')[0].trim().slice(0,30) || 'brand'}: ${cleanBody(lastBrandMsg)}`
    : '(no brand message on file)';
  // Ground-truth banner: if deal is won/signed, prepend an unambiguous statement
  // so the AI can't get confused by brand-thread recency (e.g. "DocuSign sent"
  // being interpreted as "waiting for signature" when Cooper has already signed).
  let groundTruthBanner = '';
  if (deal.state === 'won' && /signed|contract_signed|contract_received/.test(deal.raw_stage || '')) {
    groundTruthBanner = `*** GROUND TRUTH: This deal is CLOSED. state=won, raw_stage=${deal.raw_stage}. Cooper/Charlie has already signed. DO NOT say "waiting for signature" or "Cooper needs to sign". Describe what's NEXT (script, draft, post, payment). ***\n\n`;
  } else if (deal.state === 'won') {
    groundTruthBanner = `*** GROUND TRUTH: This deal is WON. state=won. Describe the next fulfillment step, not the closing. ***\n\n`;
  } else if (deal.state === 'lost') {
    groundTruthBanner = `*** GROUND TRUTH: This deal is LOST. state=lost. The summary should say the deal is dead and why, no action needed. ***\n\n`;
  }
  const user = `${groundTruthBanner}BRAND: ${deal.brand}
CONTACT: ${deal.contact_name || '(brand contact)'}
STAGE: ${deal.funnel_stage} (${deal.raw_stage || ''}), state=${deal.state}
BALL IN COURT: ${deal.ball_in_court || 'unclear'}
WHO SENT THE LAST MESSAGE: ${brandIsMostRecent ? 'BRAND (their reply is the latest)' : (lastOurMsg ? 'RILEY (you sent the latest)' : 'unclear')}
FEE: ${deal.fee_cents ? '$'+(deal.fee_cents/100).toLocaleString() : 'TBD'}
RECENT FLAGS: ${flagsList || 'none'}
PRIOR NOTE (use only if recent): ${rileyNote}

>>> LAST BRAND MESSAGE — anchor your summary on this:
${lastBrandLine}

BRAND THREAD — last ${recent.length} msgs (oldest → newest):
${recent.map(m => {
    const who = m.from_us ? 'Riley' : (m.sender ? m.sender.split('<')[0].trim().slice(0,25) : 'brand');
    const when = (m.sent_at || '').slice(0,16).replace('T',' ');
    return `[${when}] (${m.channel}) ${who}: ${cleanBody(m)}`;
  }).join('\n') || '(no recent messages ingested for this deal)'}

INTERNAL CHAT WITH ${(deal.creator_id||'').toUpperCase()} — last ${creatorChat.length} msgs (oldest → newest, cross-reference this with brand thread to know what's actually been delivered):
${creatorChat.map(m => {
    const who = m.from_us ? 'Riley' : (deal.creator_id ? deal.creator_id[0].toUpperCase()+deal.creator_id.slice(1) : 'creator');
    const when = (m.sent_at || '').slice(0,16).replace('T',' ');
    return `[${when}] ${who}: ${cleanBody(m)}`;
  }).join('\n') || '(no recent internal chat)'}`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST', headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body: JSON.stringify({ model:'gpt-4o-mini', temperature:0.3, max_tokens:120,
        messages:[{role:'system',content:sys},{role:'user',content:user}]}),
    });
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content?.trim() || '';
    // Cache
    P.db().prepare(`UPDATE deals SET ai_summary=?, ai_summary_at=datetime('now'),
      ai_summary_for=? WHERE id=?`).run(text, deal.last_activity_at || '', deal.id);
    json(res, { summary: text, cached: false, ai: true });
  } catch (e) {
    json(res, { summary: deal.next_action || '', cached:false, ai:false, error:e.message });
  }
});

// Per-deal completeness checklist
route('GET', '/api/deals/([^/]+)/checklist', async (req, res, { match }) => {
  const d = P.data.getDeal(match[1]); if (!d) return json(res, { error: 'not found' }, 404);
  const payments = P.db().prepare('SELECT * FROM payments WHERE deal_id=?').all(match[1]);
  json(res, checklistForDeal(d, payments));
});

// Global "what we owe" anti-mistake rollup
route('GET', '/api/anti-mistake', async (req, res, { url }) => {
  const creator = url.searchParams.get('creator') || undefined;
  const focus = url.searchParams.get('focus') === '1';
  const deals = P.data.listDeals({ state: 'open', creator, focus, limit: 2000 });
  const wonDeals = P.data.listDeals({ state: 'won',  creator, focus, limit: 2000 });
  const all = [...deals, ...wonDeals];
  // batch-fetch payments
  const paymentsByDeal = {};
  for (const p of P.db().prepare('SELECT * FROM payments').all())
    (paymentsByDeal[p.deal_id] ||= []).push(p);
  json(res, antiMistakeReport(all, paymentsByDeal));
});

route('GET', '/api/pricing/([^/]+)', async (req, res, { match, url }) => {
  const d = P.data.getDeal(match[1]); if (!d) return json(res, { error: 'not found' }, 404);
  const offerStr = url.searchParams.get('offer');
  const offer = offerStr ? Math.round(parseFloat(offerStr) * 100) : null;
  json(res, suggestPrice(d, { brandOffer: offer }));
});

// ---- Quick-capture: classify + (mock) execute --------------------------------
route('POST', '/api/quick-capture', async (req, res) => {
  const body = JSON.parse((await readBody(req)) || '{}');
  const intent = await P.parse.classifyIntent(body.text || '');
  // Build a preview of what would happen — UI shows this BEFORE we commit.
  const preview = previewIntent(intent);
  // Log every capture (audit).
  P.data.log({ who:'riley', action:'quick_capture',
    deal_id: intent.deal_id || null,
    summary: (body.text || '').slice(0, 200),
    meta: intent });
  json(res, { intent, preview });
});

route('POST', '/api/quick-capture/confirm', async (req, res) => {
  const { intent } = JSON.parse((await readBody(req)) || '{}');
  const result = await commitIntent(intent);
  json(res, result);
});

// ---- Payments ---------------------------------------------------------------
route('POST', '/api/payments', async (req, res) => {
  const { deal_id, amount_cents, paid_at, method, note } = JSON.parse((await readBody(req)) || '{}');
  if (!deal_id || !amount_cents) return json(res, { error: 'deal_id + amount_cents required' }, 400);
  const id = `pay_${Date.now()}_${randomUUID().slice(0,6)}`;
  const r = P.data.logPayment({ id, deal_id, amount_cents, paid_at, method, note });
  P.data.log({ who:'riley', action:'payment_logged', deal_id, summary:`+$${amount_cents/100}`, meta:r });
  json(res, r);
});

// ---- Drafts -----------------------------------------------------------------
route('GET', '/api/drafts', async (req, res) => json(res, P.data.listReadyDrafts()));

route('POST', '/api/drafts/generate', async (req, res) => {
  const { deal_id, mode: requestedMode } = JSON.parse((await readBody(req)) || '{}');
  const deal = P.data.getDeal(deal_id);
  if (!deal) return json(res, { error: 'deal not found' }, 404);

  // Auto-pick mode from checklist if not explicitly requested.
  let mode = requestedMode, autoChose = false;
  if (!mode) {
    const payments = P.db().prepare('SELECT * FROM payments WHERE deal_id=?').all(deal_id);
    const cl = checklistForDeal(deal, payments);
    mode = pickDraftMode(deal, cl);
    autoChose = true;
  }

  // Pull latest brand message if we have it (improves OpenAI context).
  const latestMessage = P.db().prepare(`SELECT * FROM messages
    WHERE thread_id IN (SELECT id FROM threads WHERE deal_id=?)
      AND from_us=0
    ORDER BY sent_at DESC LIMIT 1`).get(deal_id);

  const composed = await P.draft.draft({ deal, latestMessage, mode });
  const draft = {
    id: `dr_${Date.now()}_${randomUUID().slice(0,6)}`,
    deal_id, thread_id: deal.thread_id, channel: deal.primary_channel || 'email',
    ...composed,
    rationale: (composed.rationale || '') + (autoChose ? ` · mode auto-picked from checklist` : ''),
  };
  P.data.saveDraft(draft);
  P.data.log({ who:'system', action:'draft_generated', deal_id, summary: composed.rationale, meta:{ provider: composed.generated_by, mode, autoChose } });
  json(res, draft);
});

route('POST', '/api/drafts/([^/]+)/(approve|reject)', async (req, res, { match }) => {
  const [_, id, action] = match;
  if (action === 'reject') {
    P.data.setDraftStatus(id, 'rejected');
    P.data.log({ who:'riley', action:'draft_rejected', summary: id });
    return json(res, { ok:true });
  }
  // Approve = send via the appropriate channel.
  const draft = P.db().prepare('SELECT * FROM drafts WHERE id=?').get(id);
  if (!draft) return json(res, { error:'draft not found' }, 404);
  const deal  = P.data.getDeal(draft.deal_id);
  if (!deal)  return json(res, { error:'deal not found' }, 404);

  // Edited body comes from request (user may have tweaked)
  const overrides = JSON.parse((await readBody(req)) || '{}');
  const body = overrides.body || draft.body;

  if (draft.channel === 'email') {
    if (!hasGmailToken()) return json(res, { error:'Gmail not connected' }, 400);
    try {
      const sendRes = await sendThreadedReply({
        thread_id: draft.thread_id,
        reply_to_msg_id: draft.reply_to_msg_id || deal.latest_msg_id,
        to: deal.contact_email,
        subject: draft.subject,
        body,
      });
      P.data.setDraftStatus(id, 'sent');
      P.data.log({ who:'riley', action:'draft_sent', deal_id: draft.deal_id,
        summary: `→ ${sendRes.to}`, meta: { gmail_message_id: sendRes.id }});
      // Re-pull the thread so the just-sent message lands in the local DB
      // immediately. Without this, the conversation view doesn't show the
      // send until the next full Gmail sync (~30s+).
      try { await pullSingleThread(P.db(), draft.thread_id); } catch {}
      // Post-send freshness: invalidate the AI summary cache so the next pill
      // open re-narrates with the just-sent message, and queue a lifecycle
      // audit so the verdict picks up the new state (often: ball flips,
      // chase chip changes, step status updates).
      try {
        P.db().prepare(`UPDATE deals SET ai_summary_for = NULL WHERE id = ?`).run(draft.deal_id);
        const apiKey = process.env.OPENAI_API_KEY;
        if (apiKey && P.cfg('ai_enabled','false') === 'true') {
          const { queueAudit } = await import('./engines/lifecycle_audit.js');
          const dealRow = P.db().prepare(`SELECT * FROM deals WHERE id = ?`).get(draft.deal_id);
          if (dealRow) queueAudit({ db: P.db(), deal: dealRow, apiKey, spend: P.spend });
        }
      } catch {}
      return json(res, { ok:true, sent:true, ...sendRes });
    } catch (e) {
      return json(res, { ok:false, error: e.message }, 500);
    }
  }
  // WhatsApp + others — not wired yet
  return json(res, { ok:false, error:`Send not yet wired for channel "${draft.channel}".` }, 400);
});

// Creator chat — recent messages from COOPER X TRIIBE or CHARLIE X TRIIBE.
// Used for the pinned pill on Today to coordinate with the creator directly.
route('GET', '/api/creator-chat/([^/]+)', async (req, res, { match, url }) => {
  const creator = match[1].toLowerCase();
  if (!['cooper','charlie'].includes(creator))
    return json(res, { error:'unknown creator' }, 400);
  const chatNameLike = `%${creator.toUpperCase()} X TRIIBE%`;
  const thread = P.db().prepare(`SELECT * FROM threads
    WHERE channel='whatsapp' AND subject LIKE ?
    ORDER BY last_message_at DESC LIMIT 1`).get(chatNameLike);
  if (!thread) return json(res, { chat_name: `${creator.toUpperCase()} X TRIIBE`, messages: [], total: 0 });

  const limit = parseInt(url.searchParams.get('limit') || '15', 10);
  const messages = P.db().prepare(`
    SELECT id, sender, from_us, sent_at, body, snippet,
           media_type, media_path, media_mime, media_filename, media_size
    FROM messages WHERE thread_id = ?
    ORDER BY sent_at DESC LIMIT ?`).all(thread.id, limit).reverse();
  // Unread watermark: whichever is MORE RECENT — our last reply OR an explicit
  // "I've read up to here" stamp from when Riley opens the pill. The stamp
  // means "I saw these even though I haven't sent a reply yet."
  const lastUsAt = P.db().prepare(`SELECT MAX(sent_at) m FROM messages
    WHERE thread_id=? AND from_us=1`).get(thread.id).m;
  const readThrough = thread.read_through_at || null;
  const watermark = [lastUsAt, readThrough].filter(Boolean).sort().pop() || null;
  const unread = watermark
    ? messages.filter(m => !m.from_us && m.sent_at > watermark).length
    : messages.filter(m => !m.from_us).length;
  json(res, {
    chat_name: thread.subject,
    last_message_at: thread.last_message_at,
    ball_in_court: thread.ball_in_court,
    messages, total: messages.length, unread,
  });
});

// Mark the creator chat as read up to now — called when Riley opens the pill.
// Stops the "1 new" badge from re-appearing on the next 30s refresh.
route('POST', '/api/creator-chat/([^/]+)/mark-read', async (req, res, { match }) => {
  const creator = match[1].toLowerCase();
  if (!['cooper','charlie'].includes(creator))
    return json(res, { error:'unknown creator' }, 400);
  const chatNameLike = `%${creator.toUpperCase()} X TRIIBE%`;
  const thread = P.db().prepare(`SELECT id FROM threads
    WHERE channel='whatsapp' AND subject LIKE ?
    ORDER BY last_message_at DESC LIMIT 1`).get(chatNameLike);
  if (!thread) return json(res, { ok:false, reason:'no thread' });
  const now = new Date().toISOString();
  P.db().prepare(`UPDATE threads SET read_through_at = ? WHERE id = ?`).run(now, thread.id);
  json(res, { ok:true, read_through_at: now });
});

// AI-suggested reply for the creator chat — uses last 10 messages + ALL of
// that creator's active-deal pipeline state so the reply has full context.
route('POST', '/api/creator-chat/([^/]+)/suggest', async (req, res, { match }) => {
  const creator = match[1].toLowerCase();
  if (!['cooper','charlie'].includes(creator)) return json(res, { error:'unknown creator' }, 400);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || P.cfg('ai_enabled','false') !== 'true')
    return json(res, { ok:false, reason:'AI not enabled' }, 400);

  // 1. Recent COOPER/CHARLIE X TRIIBE messages (last 10)
  const chatThread = P.db().prepare(`SELECT id FROM threads
    WHERE channel='whatsapp' AND subject LIKE ?
    ORDER BY last_message_at DESC LIMIT 1`).get(`%${creator.toUpperCase()} X TRIIBE%`);
  if (!chatThread) return json(res, { ok:false, reason:'no internal chat found' });
  const chatMsgs = P.db().prepare(`SELECT sender, from_us, sent_at, body, snippet
    FROM messages WHERE thread_id=? ORDER BY sent_at DESC LIMIT 10`).all(chatThread.id).reverse();
  const lastFromCreator = [...chatMsgs].reverse().find(m => !m.from_us);

  // 2. ALL this creator's active deals (won + in-works/active/pitching/in conversation)
  const deals = P.data.listDeals({ creator, limit: 1000 })
    .filter(d => d.state === 'won' || ['conversation','pitching','in_works','active'].includes(d.funnel_stage))
    .filter(d => d.state !== 'lost')
    .sort((a,b) => (b.fee_cents||0) - (a.fee_cents||0))
    .slice(0, 20); // top 20 by fee to keep prompt manageable

  // 3. For each deal: AI summary, parsed contract obligations, posting date,
  // and the last 2 brand messages. This gives the AI enough grounding to
  // answer "can we post X without approval?" / "what does brand X want?"
  // questions without making things up.
  const ctxLines = [];
  for (const d of deals) {
    const latestBrandMsgs = P.db().prepare(`SELECT m.sender, m.sent_at, m.body, m.snippet
      FROM messages m JOIN threads t ON t.id=m.thread_id
      WHERE t.deal_id=? AND m.from_us=0 ORDER BY m.sent_at DESC LIMIT 2`).all(d.id).reverse();
    const fee = d.fee_cents ? '$' + (d.fee_cents/100).toLocaleString() : 'TBD';
    const stage = d.state === 'won' ? 'SIGNED' : d.funnel_stage;
    let line = `• ${d.brand} (${fee}, ${stage})`;
    if (d.posting_date) line += ` · posts ${d.posting_date.slice(0,10)}`;
    if (d.ai_summary) line += `: ${d.ai_summary}`;
    else if (d.next_action) line += `: ${d.next_action}`;
    // Contract obligations — what the brand actually requires. Critical for
    // "do we need approval before posting?" type questions Cooper asks.
    if (d.obligations) {
      let obs = null;
      try { obs = JSON.parse(d.obligations); } catch {}
      if (Array.isArray(obs) && obs.length) {
        const compact = obs.slice(0, 6).map(o => {
          if (typeof o === 'string') return o.slice(0, 100);
          const label = o.label || o.title || o.task || '';
          const detail = o.detail || o.description || '';
          return `${label}${detail ? ': ' + detail : ''}`.slice(0, 120);
        }).filter(Boolean);
        if (compact.length) line += `\n   contract: ${compact.join(' | ')}`;
      }
    }
    for (const m of latestBrandMsgs) {
      const when = (m.sent_at||'').slice(0,10);
      const who = (m.sender||'').split('<')[0].trim().slice(0,30) || 'brand';
      const txt = (m.body || m.snippet || '').replace(/\s+/g,' ').slice(0,180);
      line += `\n   ↳ ${who} ${when}: "${txt}"`;
    }
    ctxLines.push(line);
  }

  const cap = creator[0].toUpperCase() + creator.slice(1);
  const sys = `You are Riley texting ${cap} on WhatsApp. ${cap} is a creator you manage at Triibe.

TONE: short, casual, teammate-to-teammate. 1-3 sentences max. Reply directly to ${cap}'s last message.

HARD ACCURACY RULES — IF YOU BREAK ONE, RILEY HAS TO MANUALLY FIX IT:
- ONLY say things that are explicitly grounded in the deal pipeline data below. If a contract term, posting date, brand reply, or status isn't in the data, DO NOT invent it.
- If ${cap} asks something you can't answer from the data ("when does X pay?", "what's in the contract?"), say "lmk and i'll check" or "let me look into it" — do not guess.
- When citing a brand reply, paraphrase what they actually said. Do not invent quotes.
- When ${cap} asks "can we post without approval?" or similar, check the contract obligations on the relevant deal. If the contract requires approval before posting, say so — that's how Riley protects the deal.

VOICE:
- No greeting ("Hey"), no signoff ("Best", "Thanks!") — Riley jumps straight to the answer.
- Contractions are fine ("we're", "they're", "i'll"). Lowercase is fine when natural.
- Vocab Riley actually uses: "yeah", "nah", "honestly", "tbh", "for sure", "appreciate it", "got it", "all good", "lmk", "rn", "we good", "they want", "still waiting on", "I know man", "for once".
- Emojis: avoid by default. Rare 🤣 is OK if ${cap} sent something funny — never more than one.
- Sound like a guy who played D1 hockey texting his buddy, not a corporate manager.

You have FULL knowledge of every brand deal in ${cap}'s pipeline below. When ${cap} asks "any update on X?", answer with the ACTUAL current state of X — what's done, what's pending, the latest brand reply if any.`;

  const user = `${cap}'S ACTIVE DEAL PIPELINE (full context — use this when answering):
${ctxLines.join('\n\n')}

RECENT CHAT WITH ${cap.toUpperCase()} (oldest → newest, last ${chatMsgs.length}):
${chatMsgs.map(m => {
  const who = m.from_us ? 'Riley' : cap;
  const when = (m.sent_at||'').slice(11,16).replace('T','');
  return `${who} ${when}: ${(m.body || m.snippet || '').replace(/\s+/g,' ').slice(0,400)}`;
}).join('\n')}

${lastFromCreator ? `${cap}'s last message to reply to: "${(lastFromCreator.body || lastFromCreator.snippet || '').replace(/\s+/g,' ').slice(0,400)}"` : '(no recent message from ' + cap + ' — give an update on something useful)'}

Write Riley's WhatsApp reply.`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST', headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body: JSON.stringify({ model:'gpt-4o', temperature:0.3, max_tokens:240,
        messages:[{role:'system',content:sys},{role:'user',content:user}]}),
    });
    const data = await r.json();
    const body = data.choices?.[0]?.message?.content?.trim() || '';
    // Tiny usage log
    const cost = Math.round((data.usage?.prompt_tokens||0) * 0.00025)
               + Math.round((data.usage?.completion_tokens||0) * 0.001);
    P.spend.record({ provider:'openai', model:'gpt-4o', operation:'creator_chat_suggest',
      prompt_tokens: data.usage?.prompt_tokens || 0,
      completion_tokens: data.usage?.completion_tokens || 0,
      est_cost_cents: cost });
    json(res, { ok:true, body, deal_count: deals.length });
  } catch (e) {
    json(res, { ok:false, reason: e.message }, 500);
  }
});

// Brand WA reply draft — cook a short WhatsApp message from Riley to the
// BRAND CONTACT (not creator) using recent chat history as context.
// Used when deal.primary_channel === 'whatsapp'.
route('POST', '/api/brand-wa-draft', async (req, res) => {
  const { deal_id, force_new = false } = JSON.parse((await readBody(req)) || '{}');
  const deal = P.data.getDeal(deal_id);
  if (!deal) return json(res, { error:'deal not found' }, 404);

  // Pull the WA thread linked to this deal
  const waThread = P.db().prepare(`
    SELECT * FROM threads WHERE deal_id = ? AND channel = 'whatsapp'
    ORDER BY last_message_at DESC LIMIT 1`).get(deal_id);
  // Recent messages (last 15) for context
  const waMsgs = waThread ? P.db().prepare(`
    SELECT id, sender, from_us, sent_at, body, snippet FROM messages
    WHERE thread_id = ? ORDER BY sent_at DESC LIMIT 15`).all(waThread.id).reverse() : [];

  const apiKey = process.env.OPENAI_API_KEY;
  const aiEnabled = P.cfg('ai_enabled', 'false') === 'true' && apiKey;
  let body, generated_by;
  if (aiEnabled && waMsgs.length) {
    const sys = `You are Riley, replying on WhatsApp to a brand contact for ${deal.brand}.
WhatsApp tone: SHORT (1-3 sentences), casual, no greeting, no signature, no "Best Riley".
Just dive in. Riley's voice: warm, efficient, often uses "honestly", "appreciate", emojis sparingly (✅ 🙌 only).
You have the full recent chat history. Reply to the latest brand message OR provide the requested update.
Don't restate what they said. Don't ask for things already agreed. Don't add fee anchors unless explicitly relevant.`;
    const history = waMsgs.map(m => {
      const who = m.from_us ? 'Riley' : (deal.contact_name || 'brand');
      return `${who}: ${(m.body || m.snippet || '').replace(/\s+/g,' ').slice(0,500)}`;
    }).join('\n');
    const user = `BRAND: ${deal.brand}
CONTACT: ${deal.contact_name || '(brand contact)'}
DEAL STATE: ${deal.funnel_stage} (${deal.raw_stage || ''})
FEE: ${deal.fee_cents ? '$' + (deal.fee_cents/100).toLocaleString() : 'TBD'}
POSTING DATE: ${deal.posting_date || 'TBD'}
NEXT ACTION: ${deal.next_action || ''}
DETAIL: ${(deal.next_action_detail || '').slice(0,400)}

RECENT WHATSAPP (oldest → newest, last ${waMsgs.length}):
${history}

Write Riley's next WhatsApp message.`;
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method:'POST', headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
        body: JSON.stringify({ model:'gpt-4o', temperature:0.5, max_tokens:300,
          messages:[{role:'system',content:sys},{role:'user',content:user}]}),
      });
      const data = await r.json();
      body = data.choices?.[0]?.message?.content?.trim() || '';
      generated_by = 'openai:gpt-4o';
    } catch (e) {
      body = ''; generated_by = 'failed: ' + e.message;
    }
  }
  if (!body) {
    body = `Hey — quick update on ${deal.brand}: ${deal.next_action || 'circling back on next steps'}.`;
    generated_by = 'local-stub';
  }

  json(res, {
    deal, contact_name: deal.contact_name, body, generated_by,
    chat_name: waThread?.subject || `Brand chat`,
    history_count: waMsgs.length,
    last_brand_at: waMsgs.filter(m => !m.from_us).pop()?.sent_at || null,
  });
});

// Creator-ping draft — cook a short WhatsApp message from Riley to the deal's
// creator (Cooper/Charlie) summarizing what the brand needs and by when.
route('POST', '/api/creator-ping-draft', async (req, res) => {
  const { deal_id } = JSON.parse((await readBody(req)) || '{}');
  const deal = P.data.getDeal(deal_id);
  if (!deal) return json(res, { error:'deal not found' }, 404);
  const creator = (deal.creator_id || '').replace(/^./, c => c.toUpperCase());

  // Cook the ping using the local stub OR (if AI enabled) gpt-4o.
  const apiKey = process.env.OPENAI_API_KEY;
  const aiEnabled = P.cfg('ai_enabled', 'false') === 'true' && apiKey;
  let body, generated_by;
  if (aiEnabled) {
    const sys = `You are Riley, sending a LIVE UPDATE on WhatsApp to ${creator} about a brand deal.

ROLES (CRITICAL — never confuse them):
- ${creator} = the CREATOR. He films + makes creative decisions (hooks, angles, scripts). He doesn't talk to brands directly — Riley handles that.
- Riley (you) = the MANAGER. You communicate with the brand. You relay info to ${creator} and ask him for creative input when needed.
- The brand contact (HireInfluence / Mediacube / Fancy Media / etc.) is the AGENT. Riley talks to them — never ${creator}.

NEVER write things like "confirm with [brand contact]" or "let [brand] know" — ${creator} doesn't message the brand. Instead, ASK ${creator} for the answer/decision and Riley will relay it.

PRIMARY GOAL: tell ${creator} what's NEW from the brand and what creative input you need from him.
DO NOT repeat anything ${creator} already knows from the recent WhatsApp chat — only the delta.
If the recent chat already covered it, just say "FYI brand confirmed X" or skip entirely if already in flight.

VOICE (study Riley's actual WhatsApp pattern):
Real example of how Riley messaged ${creator} with brand specs:
  "Hey Velo shot a reminder for the post along with script feedback.

   Got the script with feedback here.

   Also some things the brand wants for the post along with the draft by the 15th or earlier:
   · Screen-record from the very first app launch (first-time-only screens can't be recaptured)
   · Limit B-roll
   · All CTAs point to APP DOWNLOAD, not website
   · First mention is 'ZenBusiness Velo®', then 'Velo' after
   · No music in the video, brand wants zero background noise
   · Manychat trigger word is 'VELO'"

Patterns to copy:
- Opens with "Hey [brand name] shot/sent/wants..." — punchy, brand-as-shorthand
- Plain conversational sentences before the bullet list
- · (middle dot) bullets, NOT dashes
- Casual but business. No filler ("ya know", "honestly"). No greetings (no "Hey ${creator}"). No sign-off.
- Sentences are full-length but linked by commas, like he talks

CRITICAL — WHAT TO LEAVE OUT (this is Riley's workflow rule):
- DO NOT loop ${creator} into negotiation drama, scope creep flags, price disputes, or back-and-forth with brand agents.
- ${creator} only needs: what to film, when it's due, the production specs the brand locked in. That's it.
- If brand asked Riley a scope question (hook A vs B, extra deliverable, etc.), Riley handles the negotiation and tells ${creator} only the FINAL answer once it's settled.
- Riley's rule: don't surface deal details until they're confirmed. Brands ghost. Better not to hype ${creator} on something that falls apart.
- Exception: if Riley's about to lock in a brand-new contract for a new pitch, then yes — ask ${creator} "would you do this deal for $X?" before signing.

PUNCTUATION (HARD RULE):
- NEVER use em dashes (—). Use commas to link related clauses.
- NEVER use en dashes (–) or fancy unicode quotes.
- Bullets: use · (middle dot, U+00B7) followed by space. NOT dash.
- Riley writes like he talks: full sentences linked by commas, then a labeled bullet list for specs.

FORMAT: plain text, no markdown. Specs in bullet list with · at line start. Brand context as a 1-2 line opener before the bullets.`;

    // 1) Pull BRAND-side conversation (latest 5 messages from the brand's own thread)
    //    so the AI knows exactly what the brand just said.
    const brandThreadRows = P.db().prepare(`
      SELECT m.sender, m.from_us, m.sent_at, m.body, m.snippet, t.channel, t.subject
      FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE t.deal_id = ?
      ORDER BY m.sent_at DESC LIMIT 5`).all(deal.id).reverse();
    const brandBlock = brandThreadRows.length ? `\nBRAND CONVERSATION (last 5, oldest→newest):\n` + brandThreadRows.map(m => {
      const who = m.from_us ? 'Riley' : (m.sender || 'brand').split('<')[0].trim().slice(0,30);
      const when = (m.sent_at || '').slice(0,16).replace('T',' ');
      return `[${when} ${m.channel}] ${who}: ${(m.body || m.snippet || '').replace(/\s+/g,' ').slice(0,600)}`;
    }).join('\n') + '\n' : '';

    // 2) Pull the creator-chat WhatsApp history, filtered to mentions of THIS BRAND
    //    so we know exactly what ${creator} has already heard about it.
    const creatorChatRe = `%${(deal.creator_id || '').toUpperCase()} X TRIIBE%`;
    // Build brand keywords for filtering (e.g. "ZenBusiness Velo" → "velo")
    const brandWords = (deal.brand || '').split(/[\s(,\-—]+/).map(w => w.toLowerCase()).filter(w => w.length >= 4);
    const allWaRows = P.db().prepare(`
      SELECT m.sender, m.from_us, m.sent_at, m.body, m.snippet
      FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE m.channel='whatsapp' AND COALESCE(t.subject,'') LIKE ?
      ORDER BY m.sent_at DESC LIMIT 60`).all(creatorChatRe);
    const brandSpecific = allWaRows.filter(m => {
      const text = (m.body || m.snippet || '').toLowerCase();
      return brandWords.some(w => text.includes(w));
    }).slice(0, 8).reverse();
    const waBrandBlock = brandSpecific.length ? `\nWHAT ${creator.toUpperCase()} ALREADY KNOWS ABOUT THIS BRAND (from WA, oldest→newest):\n` + brandSpecific.map(m => {
      const who = m.from_us ? 'Riley' : creator;
      const when = (m.sent_at || '').slice(0,16).replace('T',' ');
      return `[${when}] ${who}: ${(m.body || m.snippet || '').replace(/\s+/g,' ').slice(0,400)}`;
    }).join('\n') + '\n' : `\nWHAT ${creator.toUpperCase()} ALREADY KNOWS ABOUT THIS BRAND: nothing yet on WA.\n`;

    // 3) Generic recent creator-chat tone reference (last 5)
    const recentWaTone = allWaRows.slice(0, 5).reverse();
    const waToneBlock = recentWaTone.length ? `\nRECENT TONE OF MY WA WITH ${creator.toUpperCase()} (last 5, for voice matching):\n` + recentWaTone.map(m => {
      const who = m.from_us ? 'Riley' : creator;
      return `${who}: ${(m.body || m.snippet || '').replace(/\s+/g,' ').slice(0,250)}`;
    }).join('\n') + '\n' : '';

    // 4) Pull CONTRACT / BRIEF obligations so the AI can flag scope creep —
    //    brand asking for things NOT in what we signed for.
    const contractRow = P.db().prepare(`SELECT extracted, usage_rights, exclusivity_days, payment_terms, fee_cents
      FROM contracts WHERE deal_id=? ORDER BY created_at DESC LIMIT 1`).get(deal.id);
    let scopeBlock = '';
    if (contractRow) {
      let ex = {};
      try { ex = JSON.parse(contractRow.extracted || '{}'); } catch {}
      const parts = [];
      if (ex.deliverable) parts.push(`Deliverable per contract: ${ex.deliverable}`);
      if (ex.usage_rights || contractRow.usage_rights) parts.push(`Usage rights: ${ex.usage_rights || contractRow.usage_rights}`);
      if (ex.exclusivity_days != null || contractRow.exclusivity_days != null) parts.push(`Exclusivity: ${ex.exclusivity_days ?? contractRow.exclusivity_days ?? 0} days`);
      if (ex.payment_terms || contractRow.payment_terms) parts.push(`Payment: ${ex.payment_terms || contractRow.payment_terms}`);
      if (ex.posting_date_iso) parts.push(`Posting date locked: ${ex.posting_date_iso}`);
      if (ex.summary) parts.push(`Brief summary: ${ex.summary.slice(0, 300)}`);
      if (parts.length) {
        scopeBlock = `\nCONTRACT / BRIEF (what we're CONTRACTUALLY obligated to deliver — anything outside is scope creep):\n${parts.map(p => '- ' + p).join('\n')}\n`;
      }
    }
    // Also include the structured obligations array if present
    let obligations = [];
    try { obligations = JSON.parse(deal.obligations || '[]'); } catch {}
    if (obligations.length) {
      scopeBlock += `\nSTRUCTURED OBLIGATIONS:\n${obligations.map(o =>
        `- ${o.type || 'task'}: ${o.what || ''}${o.when ? ' by ' + o.when : ''}${o.required ? ' [REQUIRED]' : ''}`
      ).join('\n')}\n`;
    }

    const userPrompt = `BRAND: ${deal.brand}
DEAL STAGE: ${deal.funnel_stage} / ${deal.raw_stage || 'unknown'}
FEE: ${deal.fee_cents ? '$' + (deal.fee_cents/100).toLocaleString() : 'TBD'}
POSTING DATE: ${deal.posting_date || 'TBD'}
NEXT ACTION ON FILE: ${deal.next_action || 'TBD'}
LATEST CONTEXT NOTE: ${(deal.next_action_detail || '').slice(0,800)}
${scopeBlock}${brandBlock}${waBrandBlock}${waToneBlock}
Write a LIVE UPDATE WhatsApp message to ${creator} based on what's NEW.

STEP 1 — SCOPE CHECK (background only, NOT for the message): silently compare contract quantity vs brand asks. If they mismatch, that's RILEY'S problem to resolve with the brand. DO NOT mention any negotiation, pushback, or scope discussion in the message to ${creator}.

STEP 2 — DRAFT THE MESSAGE: only include things ${creator} needs to execute his job.
- Brand context as a punchy 1-line opener (e.g. "Hey Velo sent the script with feedback")
- Hard deadline if there is one (e.g. "they want the draft by the 15th")
- Production specs as a · bullet list (recording technique, music rules, CTA wording, hashtag rules, trigger words)
- NEVER include: scope negotiation, hook A vs B back-and-forth, price/payment, contract terms, agent/manager names like Valentine, "push back" / "charge for extra" / "scope creep" language. Riley handles that off-screen and tells ${creator} the FINAL answer once locked.

EXAMPLE — what Cooper actually got from Riley for this exact Velo update:
  "Hey Velo shot a reminder for the post along with script feedback.

   Got the script with feedback here.

   Also some things the brand wants for the post along with the draft by the 15th or earlier:
   · Screen-record from the very first app launch (first-time-only screens can't be recaptured)
   · Limit B-roll
   · All CTAs point to APP DOWNLOAD, not website
   · First mention is 'ZenBusiness Velo®', then 'Velo' after
   · No music in the video, brand wants zero background noise
   · Manychat trigger word is 'VELO'"

That's the target. Notice: zero mention of hook A vs B, zero mention of "push back", zero em dashes, zero Valentine name-drop.

PUNCTUATION (HARD RE-CHECK before output):
- Scan the draft for em dashes (—) and replace ANY with commas before returning. Em dashes are forbidden.
- Bullets must be · (middle dot), not - (hyphen).

Skip anything ${creator} already knows from the WA history above.`;
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method:'POST',
        headers:{ 'Authorization':`Bearer ${apiKey}`, 'Content-Type':'application/json' },
        body: JSON.stringify({
          // gpt-4o (not mini) — needed for scope-creep reasoning across contract + brand asks
          model:'gpt-4o', temperature:0.4, max_tokens:400,
          messages:[{role:'system',content:sys},{role:'user',content:userPrompt}],
        }),
      });
      const data = await r.json();
      body = data.choices?.[0]?.message?.content?.trim() || '';
      generated_by = 'openai:gpt-4o';
    } catch (e) {
      body = ''; generated_by = 'failed: ' + e.message;
    }
  }
  if (!body) {
    // Local fallback
    body = `Hey ${creator} — quick one on ${deal.brand}: ${deal.next_action || 'next step coming up'}. `
         + (deal.posting_date ? `Post date is ${deal.posting_date}. ` : '')
         + (deal.next_action_detail ? `Detail: ${deal.next_action_detail.slice(0,200)}` : 'Lmk when ready.');
    generated_by = 'local-stub';
  }

  // Suggest the WA chat to use
  const chatName = `${(deal.creator_id || '').toUpperCase()} X TRIIBE`;
  json(res, { deal, creator, body, generated_by, suggested_chat: chatName });
});

// Pick the best (thread_id, msg_id) to reply on for a given deal. SKIPS
// Google Docs / noreply / mailer-daemon "messages" — they're not real conversation
// threads. Returns null if no usable target exists.
function pickReplyTarget(deal_id) {
  const row = P.db().prepare(`
    SELECT m.id AS msg_id, m.thread_id, m.sender, m.sent_at
    FROM messages m
    JOIN threads t ON t.id = m.thread_id
    WHERE t.deal_id = ?
      AND m.from_us = 0
      AND COALESCE(m.sender,'') NOT LIKE '%(via Google Docs)%'
      AND COALESCE(m.sender,'') NOT LIKE '%(via Notion)%'
      AND COALESCE(m.sender,'') NOT LIKE '%drive-shares-noreply%'
      AND COALESCE(m.sender,'') NOT LIKE '%no-reply%'
      AND COALESCE(m.sender,'') NOT LIKE '%noreply%'
      AND COALESCE(m.sender,'') NOT LIKE '%mailer-daemon%'
      AND COALESCE(t.subject,'') NOT LIKE 'Document shared with you:%'
    ORDER BY m.sent_at DESC LIMIT 1`).get(deal_id);
  return row || null;
}

// Open-in-platform draft modal: returns the deal, the latest brand message
// (full body), AND a freshly-cooked AI draft. One call powers the modal.
route('POST', '/api/draft-with-context', async (req, res) => {
  const { deal_id, force_new = false, mode: requestedMode = null } = JSON.parse((await readBody(req)) || '{}');
  // If caller explicitly asked for nudge mode, force a fresh draft (don't reuse
  // an old "reply" draft) and tell the cooker which mode to use.
  const forceFresh = force_new || requestedMode === 'nudge';
  const dealPre = P.data.getDeal(deal_id);
  if (!dealPre) return json(res, { error:'deal not found' }, 404);

  // SAFETY GATE: pick the RIGHT thread to reply on (skip Google Docs / noreply
  // notification threads), pull THAT thread fresh from Gmail.
  let pulled = null;
  // First pull whatever thread the deal has (so its messages are fresh, and
  // email-matching can rescue thread→deal links).
  if (hasGmailToken() && dealPre.thread_id) {
    try { await pullSingleThread(P.db(), dealPre.thread_id); } catch {}
  }
  // Now pick the best reply target (might be a DIFFERENT thread than deal.thread_id).
  const target = pickReplyTarget(deal_id);
  // If we found a different thread, pull THAT one too so its messages are fresh.
  if (hasGmailToken() && target && target.thread_id !== dealPre.thread_id) {
    try { pulled = await pullSingleThread(P.db(), target.thread_id); }
    catch (e) { pulled = { ok:false, reason: e.message }; }
    // Persist the correction so future opens go straight to the right thread.
    P.db().prepare(`UPDATE deals SET thread_id=?, latest_msg_id=? WHERE id=?`)
      .run(target.thread_id, target.msg_id, deal_id);
  } else if (target) {
    pulled = { ok:true, last_at: target.sent_at, last_by:'them', thread_id: target.thread_id };
  }
  const deal = P.data.getDeal(deal_id);

  // Latest brand message (post-pull) — restricted to the corrected thread when known.
  const latestMsg = target
    ? P.db().prepare(`SELECT * FROM messages WHERE id=?`).get(target.msg_id)
    : P.db().prepare(`SELECT * FROM messages
        WHERE thread_id IN (SELECT id FROM threads WHERE deal_id=?) AND from_us=0
        ORDER BY sent_at DESC LIMIT 1`).get(deal_id);
  // Reuse a recent ready draft if one exists (unless caller forces new)
  let draft = null;
  if (!forceFresh) {
    draft = P.db().prepare(`SELECT * FROM drafts WHERE deal_id=? AND status='ready'
      ORDER BY created_at DESC LIMIT 1`).get(deal_id);
  }
  // If no usable draft, cook a fresh one with auto-mode (or the requested mode)
  if (!draft) {
    const payments = P.db().prepare('SELECT * FROM payments WHERE deal_id=?').all(deal_id);
    const cl = checklistForDeal(deal, payments);
    const mode = requestedMode === 'nudge' ? 'nudge_follow_up' : pickDraftMode(deal, cl);
    // Pull the full email thread history (last 20 messages oldest→newest) for context.
    const replyThreadId = target?.thread_id || deal.thread_id;
    const threadHistory = replyThreadId ? P.db().prepare(`
      SELECT id, sender, from_us, sent_at, snippet, body, channel
      FROM messages WHERE thread_id = ?
      ORDER BY sent_at DESC LIMIT 20`).all(replyThreadId).reverse() : [];
    // Pull related WhatsApp messages for this deal (last 20) — gives AI cross-channel context.
    const waHistory = P.db().prepare(`
      SELECT m.id, m.sender, m.from_us, m.sent_at, m.snippet, m.body, m.channel
      FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE t.deal_id = ? AND m.channel = 'whatsapp'
      ORDER BY m.sent_at DESC LIMIT 20`).all(deal_id).reverse();
    const composed = await P.draft.draft({
      deal, latestMessage: latestMsg, mode,
      threadHistory, waHistory,
    });
    draft = {
      id: `dr_${Date.now()}_${randomUUID().slice(0,6)}`,
      deal_id,
      // Use the CORRECTED thread/msg from pickReplyTarget (not deal.thread_id
      // directly — that may point at a stale notification thread).
      thread_id: target?.thread_id || deal.thread_id,
      channel: deal.primary_channel || 'email',
      reply_to_msg_id: target?.msg_id || latestMsg?.id || deal.latest_msg_id,
      ...composed,
      status: 'ready',
    };
    P.data.saveDraft(draft);
    P.data.log({ who:'system', action:'draft_generated', deal_id, summary: composed.rationale, meta:{ mode, provider: composed.generated_by }});
  }
  json(res, { deal, latest_message: latestMsg, draft, gmail_pull: pulled });
});

// ---- Reminders --------------------------------------------------------------
route('GET', '/api/reminders', async (req, res) => json(res, P.data.listReminders()));

// ---- Calendar: posting events + deliveries + exclusivity blackouts ---------
const MONTH_MAP = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
function parseDeliveryDateFromFlag(flag, yearHint = new Date().getFullYear()) {
  // patterns: deliver_today_jun5, cooper_delivery_fri_jun5, _jun20, etc.
  const m = flag.toLowerCase().match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(\d{1,2})/);
  if (!m) return null;
  const month = MONTH_MAP[m[1]], day = parseInt(m[2], 10);
  if (!month || !day || day > 31) return null;
  return `${yearHint}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}
function inferDeliveryDate(deal) {
  const flags = deal.flags || [];
  // Most-specific first: "deliver_today_jun5" or "deliver_<weekday>_jun5"
  for (const f of flags) {
    if (/^deliver/i.test(f) || /cooper_delivery|charlie_delivery|delivery_due/i.test(f)) {
      const d = parseDeliveryDateFromFlag(f);
      if (d) return { date: d, flag: f };
    }
  }
  // Production window end
  if (deal.extra?.production_window) {
    const m = String(deal.extra.production_window).match(/(\d{4}-\d{2}-\d{2})/g);
    if (m && m.length) return { date: m[m.length - 1], flag: 'production_window_end' };
  }
  // Last resort: posting_window_end on raw-footage deals
  if (deal.raw_footage_no_posting && deal.posting_window_end)
    return { date: deal.posting_window_end, flag: 'posting_window_end' };
  return null;
}

route('GET', '/api/calendar', async (req, res, { url }) => {
  const creator = url.searchParams.get('creator') || 'cooper';
  const monthIso = url.searchParams.get('month') || new Date().toISOString().slice(0,7);
  // Pull every signed/in-works/active deal for this creator
  const deals = P.data.listDeals({ creator, limit: 2000 })
    .filter(d => d.state === 'won' || ['in_works','active','completed'].includes(d.funnel_stage));

  const events = [];      // posting events
  const deliveries = [];  // raw-footage delivery dates
  const blackouts = [];   // exclusivity windows

  // Also pull ready drafts (= "approve & send today" deadlines) and
  // payments due (signed deals that haven't been paid yet → net-30 from posting).
  const readyDrafts = P.db().prepare(`SELECT dr.id, dr.deal_id, d.brand, d.creator_id, d.fee_cents
    FROM drafts dr JOIN deals d ON d.id = dr.deal_id
    WHERE dr.status='ready' AND d.creator_id = ?`).all(creator);
  const paymentsDone = new Set(P.db().prepare(
    'SELECT DISTINCT deal_id FROM payments WHERE status=?').all('paid').map(r => r.deal_id));

  for (const d of deals) {
    const post = d.posting_date || d.posting_window_start;
    if (post && !d.raw_footage_no_posting) {
      events.push({
        kind: 'post', date: post, deal_id: d.id, brand: d.brand,
        category: d.category, fee_cents: d.fee_cents, state: d.state,
      });
    }
    if (d.raw_footage_no_posting) {
      const del = inferDeliveryDate(d);
      if (del) deliveries.push({
        kind: 'delivery', date: del.date, deal_id: d.id, brand: d.brand,
        category: d.category, fee_cents: d.fee_cents, state: d.state, evidence: del.flag,
      });
    }
    // Exclusivity blackout — only on real-post deals
    if (d.exclusivity_required && d.exclusivity_days && post && !d.raw_footage_no_posting) {
      const start = new Date(post);
      const end = new Date(start); end.setDate(end.getDate() + (d.exclusivity_days - 1));
      blackouts.push({
        deal_id: d.id, brand: d.brand, category: d.category,
        start: post, end: end.toISOString().slice(0,10),
        days: d.exclusivity_days,
      });
    }
  }

  // Payment-due deadlines: for any won/in_works deal with a known posting/delivery
  // date + fee_cents > 0 + not yet paid → default to net-30 after that date.
  const payments = [];
  for (const d of deals) {
    if (!d.fee_cents || d.fee_cents <= 0) continue;
    if (d.state === 'lost') continue;
    if (paymentsDone.has(d.id)) continue;
    // Anchor for net-30 = explicit invoice/posting/delivery date
    const anchor = d.posting_date || (d.raw_footage_no_posting ? inferDeliveryDate(d)?.date : null);
    if (!anchor) continue;
    const nt = 30; // default net-30 if not specified (TODO: per-deal payment_terms field)
    const due = new Date(anchor); due.setDate(due.getDate() + nt);
    payments.push({
      kind: 'payment_due', date: due.toISOString().slice(0,10),
      deal_id: d.id, brand: d.brand, fee_cents: d.fee_cents,
      anchor, net_terms: nt,
    });
  }

  // Ready-draft deadlines: anchored to TODAY (you need to approve & send today)
  const today = new Date().toISOString().slice(0,10);
  const draftsDue = readyDrafts.map(dr => ({
    kind: 'draft_ready', date: today, deal_id: dr.deal_id,
    brand: dr.brand, fee_cents: dr.fee_cents, draft_id: dr.id,
  }));

  json(res, { creator, month: monthIso, events, deliveries, payments, drafts: draftsDue, blackouts });
});

// ---- Contracts / briefs upload + AI extraction ------------------------------
route('GET', '/api/contracts', async (req, res, { url }) => {
  const creator = url.searchParams.get('creator');
  const filter = creator ? 'AND d.creator_id = ?' : '';
  const args = creator ? [creator] : [];
  const rows = P.db().prepare(`
    SELECT c.id, c.deal_id, c.file_path, c.status, c.fee_cents, c.payment_terms,
           c.usage_rights, c.usage_expiry, c.exclusivity_days, c.redline_flags,
           c.extracted, c.created_at, d.brand, d.creator_id
    FROM contracts c LEFT JOIN deals d ON d.id = c.deal_id
    WHERE 1=1 ${filter}
    ORDER BY c.created_at DESC LIMIT 200`).all(...args);
  json(res, rows.map(r => ({
    ...r,
    redline_flags: tryParse(r.redline_flags, []),
    extracted: tryParse(r.extracted, {}),
  })));
});

// Multipart upload — parse manually so we don't add Express/Multer.
route('POST', '/api/contracts/upload', async (req, res) => {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('multipart/form-data')) {
    return json(res, { ok:false, reason:'use multipart/form-data' }, 400);
  }
  const boundaryStr = contentType.split('boundary=')[1];
  if (!boundaryStr) return json(res, { ok:false, reason:'no boundary' }, 400);
  const boundary = Buffer.from('--' + boundaryStr);

  // Collect body as a real Buffer (NOT a binary string — that corrupts PDFs).
  const chunks = [];
  req.on('data', c => chunks.push(c));
  await new Promise(r => req.on('end', r));
  const body = Buffer.concat(chunks);

  // Walk through buffer splitting on the boundary, preserving raw bytes.
  let fileName = null, dealHint = null, brandHint = null, fileBuf = null;
  let pos = 0;
  while (pos < body.length) {
    const boundIdx = body.indexOf(boundary, pos);
    if (boundIdx < 0) break;
    const nextIdx = body.indexOf(boundary, boundIdx + boundary.length);
    if (nextIdx < 0) break;
    const partStart = boundIdx + boundary.length + 2; // skip \r\n after boundary
    const partEnd = nextIdx - 2; // strip \r\n before next boundary
    if (partEnd > partStart) {
      const part = body.slice(partStart, partEnd);
      // Split headers from content
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd >= 0) {
        const headers = part.slice(0, headerEnd).toString('utf8');
        const content = part.slice(headerEnd + 4);
        const cd = /Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]+)")?/i.exec(headers);
        if (cd) {
          const fieldName = cd[1];
          if (fieldName === 'file' && cd[2]) {
            fileName = cd[2];
            fileBuf = content;
          } else if (fieldName === 'deal_id') dealHint = content.toString('utf8').trim();
          else if (fieldName === 'brand')    brandHint = content.toString('utf8').trim();
        }
      }
    }
    pos = nextIdx;
  }
  if (!fileBuf || !fileName) return json(res, { ok:false, reason:'no file in upload' }, 400);

  // Dedupe: check by SHA-256 BEFORE writing to disk.
  const { createHash } = await import('node:crypto');
  const fileHash = createHash('sha256').update(fileBuf).digest('hex');
  const existing = P.db().prepare(`SELECT c.id, c.file_path, c.deal_id, c.status, d.brand
    FROM contracts c LEFT JOIN deals d ON d.id = c.deal_id
    WHERE c.file_hash = ? LIMIT 1`).get(fileHash);
  if (existing) {
    return json(res, { ok:true, duplicate:true, id: existing.id,
      reason: `This file is already uploaded${existing.brand ? ' (linked to '+existing.brand+')' : ''}.`,
      existing });
  }

  // Save to disk
  const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, '_');
  const stamp = Date.now();
  const outPath = `${ROOT}/contracts/${stamp}-${safeName}`;
  mkdirSync(`${ROOT}/contracts`, { recursive: true });
  writeFileSync(outPath, fileBuf);

  // Extract text
  let text = '', kind = null, pages = null;
  try {
    const t = await extractText(outPath);
    text = t.text; kind = t.kind; pages = t.pages || null;
  } catch (e) {
    return json(res, { ok:false, reason:'extract failed: ' + e.message }, 500);
  }

  // Resolve deal: by hint, or by smart brand match.
  let deal = dealHint ? P.data.getDeal(dealHint) : null;
  const norm = s => (s || '').toLowerCase()
    .replace(/\.(ai|com|io|co|app|inc)\b/g,'')
    .replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  if (!deal) {
    const needle = norm(brandHint || fileName);
    const candidates = P.data.listDeals({ limit: 2000 });
    const matchBy = (brandStr) => {
      const b = norm(brandStr);
      if (!b) return null;
      if (needle.includes(b)) return true;
      // Try each significant word
      return b.split(' ').some(w => w.length > 3 && needle.includes(w));
    };
    deal = candidates.find(d => matchBy(d.brand));
  }

  // AI extract terms
  let extraction = null;
  try {
    const agreed = deal ? {
      fee_usd: deal.fee_cents ? deal.fee_cents / 100 : null,
      posting_date: deal.posting_date, exclusivity_days: deal.exclusivity_days,
      usage_rights: deal.usage_rights,
    } : null;
    const r = await aiExtractTerms({ text, brand: deal?.brand || brandHint, dealAgreedTerms: agreed });
    extraction = r?.extracted || null;
  } catch (e) {
    console.warn('AI extract failed:', e.message);
  }

  // Second-pass deal matching: if still unlinked, use AI-extracted brand_party.
  // Catches "PlayOS, Inc." → Sintra.ai (since PlayOS is Sintra's parent).
  if (!deal && extraction?.brand_party) {
    const needle2 = norm(extraction.brand_party);
    const candidates = P.data.listDeals({ limit: 2000 });
    deal = candidates.find(d => {
      const b = norm(d.brand);
      return b && (needle2.includes(b) || b.split(' ').some(w => w.length > 3 && needle2.includes(w)));
    });
    // Also try: the deal's contact_name or contact_email domain might mention the parent
    if (!deal && extraction.brand_party) {
      deal = candidates.find(d => {
        const blob = norm(`${d.brand} ${d.agency || ''} ${d.contact_name || ''}`);
        const partyWords = needle2.split(' ').filter(w => w.length > 3);
        return partyWords.some(w => blob.includes(w));
      });
    }
  }

  // Save to contracts table
  const cid = `c_${stamp}_${randomUUID().slice(0,6)}`;
  P.db().prepare(`INSERT INTO contracts (id, deal_id, file_path, file_hash, status,
      fee_cents, payment_terms, usage_rights, usage_expiry, exclusivity_days,
      redline_flags, extracted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    cid, deal?.id || null, outPath.replace(ROOT+'/', ''), fileHash,
    extraction?.is_brief ? 'brief' : 'received',
    extraction?.fee_usd != null ? Math.round(extraction.fee_usd * 100) : null,
    extraction?.payment_terms || null,
    extraction?.usage_rights || null,
    extraction?.usage_expiry_iso || null,
    extraction?.exclusivity_days || null,
    JSON.stringify(extraction?.redline_flags || []),
    JSON.stringify(extraction || {}),
  );

  // Bump deal: mark contract_received via a flag + bump last_activity + obligations
  let promotion = null;
  if (deal) {
    const flags = [...(deal.flags || [])];
    if (!flags.includes('contract_pdf_received')) flags.push('contract_pdf_received');
    // Persist structured obligations from AI extraction so the brain can later
    // distinguish contract requirements from brand-side soft asks.
    const obligationsJson = extraction?.obligations
      ? JSON.stringify(extraction.obligations)
      : null;
    P.db().prepare(`UPDATE deals SET flags=?, last_activity_at=datetime('now'),
      last_activity_by='us',
      obligations=COALESCE(?, obligations) WHERE id=?`)
      .run(JSON.stringify(flags), obligationsJson, deal.id);
    P.data.log({ who:'riley', action:'contract_uploaded', deal_id: deal.id,
      summary:`${fileName} → ${extraction?.summary || 'parsed'}` });

    // Tier-1 auto-promote: re-fetch the deal to get the freshest snapshot
    // (flags update above mutates the row) then push it to contract_received.
    try {
      const freshDeal = P.data.getDeal(deal.id);
      promotion = promoteFromContract({ db: P.db(), deal: freshDeal, extracted: extraction });
      if (promotion.promoted) {
        console.log(`[auto-promote] ${deal.brand} → ${promotion.applied.new_raw_stage} (notif ${promotion.notification_id})`);
      }
    } catch (e) {
      console.warn('[auto-promote contract] failed:', e.message);
    }
  }

  json(res, { ok:true, id: cid, file: safeName, kind, pages, text_chars: text.length,
              deal: deal ? { id: deal.id, brand: deal.brand } : null,
              extracted: extraction,
              promoted: !!promotion?.promoted, notification_id: promotion?.notification_id });
});

// Delete a contract (DB record + file on disk).
route('POST', '/api/contracts/([^/]+)/delete', async (req, res, { match }) => {
  const id = match[1];
  const row = P.db().prepare('SELECT id, file_path FROM contracts WHERE id=?').get(id);
  if (!row) return json(res, { ok:false, reason:'not found' }, 404);
  try {
    const full = row.file_path?.startsWith('/') ? row.file_path : `${ROOT}/${row.file_path}`;
    const fs = await import('node:fs');
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch (e) { /* ignore — DB row deletion is the source of truth */ }
  P.db().prepare('DELETE FROM contracts WHERE id=?').run(id);
  json(res, { ok:true, deleted: id });
});

function tryParse(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }

// ---- Can-we-do pre-commit clash check ---------------------------------------
route('POST', '/api/can-we-do', async (req, res) => {
  const { creator, category, date } = JSON.parse((await readBody(req)) || '{}');
  const deals = P.data.listDeals({ state: 'open', limit: 2000 });
  json(res, canDo({ deals, creator, category, date }));
});

// ---- Sync from live deals.json (re-snapshot + re-migrate, NON-DESTRUCTIVE) ---
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const pexec = promisify(execFile);
// Tell the desk — strategic Q&A. Builds a compact snapshot of every active
// deal (summary, ball, days quiet, chase status, key dates, contact, last
// brand intent) + this month's money pulse, hands to GPT with a strategist
// system prompt that knows Riley's voice. Returns a 1–3 paragraph answer
// referencing specific brands by name with the recommended action.
route('POST', '/api/desk/ask', async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const { question, history, creator } = JSON.parse(body || '{}');
  if (!question || !question.trim()) return json(res, { error: 'no question' }, 400);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || P.cfg('ai_enabled','false') !== 'true') {
    return json(res, { error: 'AI disabled' }, 503);
  }
  const targetCreator = (creator || 'cooper').toLowerCase();

  // Pull this-week (confirmed + pending) + chase metadata so the prompt has
  // everything the homepage shows + the AI summaries it has cached.
  let tw = null;
  try {
    const r = await fetch(`http://localhost:${PORT}/api/this-week?creator=${encodeURIComponent(targetCreator)}`);
    if (r.ok) tw = await r.json();
  } catch {}

  // Money pulse — target progress.
  let mp = null;
  try {
    const r = await fetch(`http://localhost:${PORT}/api/money-pulse?creator=${encodeURIComponent(targetCreator)}`);
    if (r.ok) mp = await r.json();
  } catch {}

  // Build compact deal lines: brand · stage · fee · ball · days quiet · chase
  // · post date · last summary (truncated). One line per deal, max 25 deals.
  const formatDeal = (d) => {
    const fee = d.fee_cents ? `$${(d.fee_cents/100/1000).toFixed(1)}K` : 'no$';
    const ball = d.ball_in_court === 'brand' ? 'ball:brand' :
                 d.ball_in_court === 'us' || d.ball_in_court === 'riley' ? 'ball:us' : 'ball:?';
    const chase = d.chase ? `${d.chase.kind === 'we_owe' ? 'WE_OWE' : 'STALLED'} ${d.chase.days_quiet}d` : '';
    const kd = d.key_dates || {};
    const dates = [
      kd.post && `post:${kd.post}`, kd.script_due && `script:${kd.script_due}`,
      kd.draft_due && `draft:${kd.draft_due}`, kd.payment_due && `pay:${kd.payment_due}`,
    ].filter(Boolean).join(' ');
    const deal = P.db().prepare(`SELECT ai_summary, contact_name FROM deals WHERE id=?`).get(d.deal_id);
    const summary = (deal?.ai_summary || '').replace(/\s+/g,' ').slice(0, 220);
    const contact = deal?.contact_name || '?';
    // How recently Riley sent an outbound to this deal — critical signal so
    // the desk doesn't suggest a fresh nudge for something he just nudged.
    const lastOurs = P.db().prepare(`SELECT MAX(m.sent_at) AS t
      FROM messages m JOIN threads t ON t.id=m.thread_id
      WHERE t.deal_id=? AND m.from_us=1`).get(d.deal_id);
    const lastOurAt = lastOurs?.t || null;
    const hoursSinceOurs = lastOurAt
      ? Math.floor((Date.now() - new Date(lastOurAt).getTime()) / 3_600_000)
      : null;
    const youSent = hoursSinceOurs == null ? 'never'
      : hoursSinceOurs < 24 ? `${hoursSinceOurs}h ago`
      : `${Math.floor(hoursSinceOurs/24)}d ago`;
    return `- [${d.deal_id}] ${d.brand} · ${d.state}/${d.raw_stage} · ${fee} · ${ball} · ${chase} · contact:${contact} · you_last_sent:${youSent} ${dates ? '· ' + dates : ''}\n    last: ${summary}`;
  };
  // Partition pending deals by recent action. Anything you nudged in the last
  // 48h goes into a "do-not-suggest" sidebar so the AI sees the state but
  // can't recommend chasing it again until the brand has had time to reply.
  const partition = (list) => {
    const live = [], recent = [];
    (list || []).forEach(d => {
      const lastOurs = P.db().prepare(`SELECT MAX(m.sent_at) AS t
        FROM messages m JOIN threads t ON t.id=m.thread_id
        WHERE t.deal_id=? AND m.from_us=1`).get(d.deal_id);
      const hoursSinceOurs = lastOurs?.t
        ? Math.floor((Date.now() - new Date(lastOurs.t).getTime()) / 3_600_000)
        : null;
      if (hoursSinceOurs != null && hoursSinceOurs < 48) recent.push(d);
      else live.push(d);
    });
    return { live, recent };
  };
  const conf = partition(tw?.deals);
  const pend = partition(tw?.pending);
  const confirmed = conf.live.slice(0, 12).map(formatDeal).join('\n');
  const pending   = pend.live.slice(0, 15).map(formatDeal).join('\n');
  const recentlyActed = [...conf.recent, ...pend.recent].slice(0, 10).map(formatDeal).join('\n');

  const pulse = mp ? `MTD: $${Math.round((mp.booked_cents||0)/100)} booked of $${Math.round((mp.target_cents||0)/100)} target (${mp.pct}%, pace ${mp.expected_pct}%). Projected with open pitches: $${Math.round((mp.projected_cents||0)/100)}.` : 'pulse unavailable';

  const sys = `You are the strategic desk for Riley Wallack — brand-partnership manager at Triibe Talents for hockey creator Cooper Simson (and Charlie). Riley wants short, direct, ACTIONABLE answers.

YOU KNOW: every active deal (brand, fee, stage, ball, days quiet, chase urgency, key dates, AI summary) + this month's booking pace vs $15K target.

YOUR JOB — first detect what KIND of question Riley is asking, then pick brands from the right block:

INTENT A — SALES/PIPELINE ("who should I hit up", "what should I close", "what pitches to push"):
  → Pick from PENDING. These are deals not yet locked in.

INTENT B — FULFILLMENT/ACTIVE-DEAL WORK ("what do I owe today", "what's owed on Cooper's active deals", "keep Coop aligned with active brand deals", "what's left to do on signed deals"):
  → Pick from CONFIRMED. These are signed/in-works deals where Riley owes a deliverable (script feedback, draft review, post lock-in, invoice, payment chase). Read each deal's "last: <summary>" carefully — if it mentions "waiting for Cooper to film" or "script needs revision" or "payment routing" or "draft owed", THAT is the action.

INTENT C — STRATEGY/PACE: answer with the actual numbers from the totals.

Specific brand question → give the read of where it stands + the next move regardless of block.

DO NOT SUGGEST DEALS RILEY ALREADY ACTED ON:
- Each deal line includes "you_last_sent:Xh ago" or "Xd ago".
- If you_last_sent < 48h: DO NOT suggest another nudge or follow-up. Skip that deal entirely. Brand has not had time to reply yet.
- If you_last_sent >= 48h AND ball is on brand: fair game to suggest a follow-up.
- Exception: if Riley explicitly asks about that specific brand by name, give him the read even if he just acted on it.

OUTPUT: return ONLY a JSON object with this exact shape:
{
  "intro": "1-sentence framing — what you found, the big picture",
  "actions": [
    { "deal_id": "<exact deal_id from the pipeline list>", "brand": "Brand name", "contact": "Contact first name or null", "why": "1-2 sentences citing the actual signal — days quiet, what brand said, money on table", "suggestion": "1-2 sentences with the literal message to send (or 'No reply yet' style action)" }
  ]
}

If the question doesn't warrant per-deal actions (e.g. "am I behind pace"), return intro only with empty actions array.

VOICE for intro + why + suggestion: short, direct, no em dashes, no "I recommend considering" — say "Hit up Mamita today, here's why." Use "you" not "Riley". Talk like a co-conspirator who's read everything.`;

  const user = `${pulse}

CONFIRMED (signed/in-works) deals:
${confirmed || '(none)'}

PENDING (negotiating, chase, follow-up) deals — these are the deals you may suggest actions for:
${pending || '(none)'}

RECENTLY ACTED (Riley already nudged in last 48h — DO NOT suggest follow-ups for these. Only mention if asked by brand name):
${recentlyActed || '(none)'}

${history && history.length ? `PRIOR TURNS (oldest first):\n${history.slice(-6).map(t => `${t.role==='user'?'Riley':'Desk'}: ${typeof t.content === 'string' ? t.content : JSON.stringify(t.content)}`).join('\n')}\n\n` : ''}Riley's question: ${question}

Return the JSON object now. Pick specific brands and use exact deal_ids from the lists above.`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST', headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body: JSON.stringify({ model:'gpt-4o-mini', temperature:0.4, max_tokens:900,
        response_format: { type: 'json_object' },
        messages:[{role:'system',content:sys},{role:'user',content:user}]}),
    });
    if (!r.ok) {
      const txt = await r.text().catch(()=>'');
      return json(res, { error:'ai err', detail:txt.slice(0,200) }, 502);
    }
    const data = await r.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || '{}';
    let parsed = { intro: '', actions: [] };
    try { parsed = JSON.parse(raw); } catch {}
    // Validate + sanitize. Drop actions whose deal_id isn't a real deal so we
    // don't hand the UI dead links.
    const validIds = new Set([...(tw?.deals || []), ...(tw?.pending || [])].map(d => d.deal_id));
    const cleanActions = (parsed.actions || []).filter(a => a && a.deal_id && validIds.has(a.deal_id))
      .map(a => ({
        deal_id: String(a.deal_id),
        brand: String(a.brand || '').slice(0, 80),
        contact: a.contact ? String(a.contact).slice(0, 40) : null,
        why: String(a.why || '').slice(0, 400),
        suggestion: String(a.suggestion || '').slice(0, 600),
      })).slice(0, 6);
    const usage = data.usage || {};
    P.spend?.record?.({
      provider:'openai', model:'gpt-4o-mini', operation:'desk_ask',
      prompt_tokens: usage.prompt_tokens||0, completion_tokens: usage.completion_tokens||0,
      est_cost_cents: Math.ceil(((usage.prompt_tokens||0)*0.000015 + (usage.completion_tokens||0)*0.00006) * 100),
    });
    json(res, {
      intro: String(parsed.intro || '').slice(0, 600),
      actions: cleanActions,
    });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

// Tell the desk — check whether any of the suggested actions have already
// been acted on. For each {deal_id, since}, returns acted=true if Riley has
// any outbound message to that deal newer than `since`. The desk UI uses
// this to grey out / strike through action pills the moment Riley sends a
// reply or nudge, so the list visibly shrinks as he works through it.
route('POST', '/api/desk/check-actions', async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const items = JSON.parse(body || '[]');
  if (!Array.isArray(items)) return json(res, []);
  const out = items.map(it => {
    const r = P.db().prepare(`
      SELECT MAX(m.sent_at) AS acted_at
      FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE t.deal_id = ? AND m.from_us = 1 AND m.sent_at > ?`)
      .get(it.deal_id, it.since || '2000-01-01');
    return { deal_id: it.deal_id, acted: !!r?.acted_at, acted_at: r?.acted_at || null };
  });
  json(res, out);
});

route('POST', '/api/sync', async (req, res) => {
  try {
    // copy the live file into our read-only snapshot, then re-migrate (UPSERT).
    await pexec('bash', ['-c', `
      chmod 644 ${ROOT}/migration/source/deals.snapshot.json 2>/dev/null || true
      cp /Users/rileywallack/triibe-ops/data/deals.json ${ROOT}/migration/source/deals.snapshot.json
      chmod 444 ${ROOT}/migration/source/deals.snapshot.json
    `]);
    const { stdout } = await pexec('node', ['--no-warnings', `${ROOT}/db/migrate.js`]);
    // Now ingest threads + messages (Gmail headers + WhatsApp full bodies).
    const ingestStats = ingestAll(P.db());
    // If Gmail OAuth is set up, also do a LIVE pull (bodies + ball-in-court flips).
    let gmailLive = null;
    if (hasGmailToken()) {
      try {
        const provider = new GmailInboundProvider(P.db());
        gmailLive = await provider.pull({ query: 'newer_than:2d (in:inbox OR in:sent)' });
      } catch (e) {
        gmailLive = { ok:false, reason: e.message };
      }
    } else {
      gmailLive = { ok:false, reason:'token.json missing — run `npm run gmail-auth` once.' };
    }
    // Force the WA daemon to run its backfill loop NOW — catches anything the
    // live message_create event missed (daemon brief restart, OS sleep, etc.).
    // Yesterday's Cooper messages didn't surface until manual sync — this
    // closes that gap so every /api/sync also catches WA up.
    let waBackfill = null;
    try {
      const r = await fetch('http://localhost:4745/backfill', {
        method: 'POST',
        signal: AbortSignal.timeout(15_000)
      });
      waBackfill = r.ok ? await r.json() : { ok:false, reason:'backfill failed', status: r.status };
    } catch (e) {
      waBackfill = { ok:false, reason: e.message };
    }
    // Reconcile thread + deal state from the actual messages so denormalized
    // tracking columns (last_message_at/by, ball_in_court) stay accurate.
    // Critical: without this, your own outbound replies that get re-indexed by
    // Gmail don't flip the ball back to brand, and Inbox lies to you.
    const reconciled = reconcileThreadStates({ db: P.db() });
    // Queue AI lifecycle audits for any deal that had activity recently. The
    // queue is debounced per-deal so a burst of msgs = one audit. This is the
    // mechanism that makes the lifecycle checklist auto-update without manual
    // checkboxes — every brand reply or outbound triggers a re-audit ~30s
    // after it lands.
    let lifecycleQueued = 0;
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (apiKey && P.cfg('ai_enabled','false') === 'true') {
        const { queueAudit } = await import('./engines/lifecycle_audit.js');
        // Any deal touched in the last 5 minutes (covers Gmail + WA new activity)
        const recentDeals = P.db().prepare(`
          SELECT id, brand, creator_id, fee_cents, posting_date, funnel_stage,
                 raw_stage, state, payment_terms_days
          FROM deals
          WHERE last_activity_at > datetime('now', '-5 minutes')
            AND state != 'lost'
            AND funnel_stage NOT IN ('cold','dormant')
        `).all();
        for (const d of recentDeals) {
          queueAudit({ db: P.db(), deal: d, apiKey, spend: P.spend });
          lifecycleQueued++;
        }
      }
    } catch (e) {
      console.warn('lifecycle audit queue err:', e.message);
    }
    P.data.log({ who:'riley', action:'sync',
      summary:'re-snapshot + re-migrate + ingest + live Gmail + WA backfill + reconcile + lifecycle audit queue',
      meta: { ingest: ingestStats, gmail_live: gmailLive, wa_backfill: waBackfill, reconcile: reconciled, lifecycle_queued: lifecycleQueued } });
    json(res, { ok:true, log: stdout.trim().split('\n').slice(-8), ingest: ingestStats, gmail_live: gmailLive, wa_backfill: waBackfill, reconcile: reconciled });
  } catch (e) {
    json(res, { ok:false, error: e.message }, 500);
  }
});

// Manual reconcile — useful if state ever drifts. Cheap, idempotent.
route('POST', '/api/reconcile', async (req, res) => {
  const r = reconcileThreadStates({ db: P.db() });
  json(res, { ok:true, ...r });
});

// Run AI audit on a single deal NOW (synchronous). Returns the verdict.
// Used by the per-pill "🔍 Re-audit" button.
route('POST', '/api/lifecycle/audit/([^/]+)', async (req, res, { match }) => {
  const deal_id = decodeURIComponent(match[1]);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return json(res, { ok:false, reason:'no OPENAI_API_KEY' }, 503);
  const deal = P.db().prepare('SELECT * FROM deals WHERE id = ?').get(deal_id);
  if (!deal) return json(res, { ok:false, reason:'deal not found' }, 404);
  const { auditDealLifecycle } = await import('./engines/lifecycle_audit.js');
  const verdict = await auditDealLifecycle({ db: P.db(), deal, apiKey, spend: P.spend });
  if (!verdict) return json(res, { ok:false, reason:'audit failed (see server logs)' }, 500);
  json(res, { ok:true, deal_id, verdict, audited_at: new Date().toISOString() });
});

// Bulk audit — runs audit on every active deal. Slow (~30s for 30 deals).
// Used for one-time backfill so the cached lifecycle_state is populated.
route('POST', '/api/lifecycle/audit-all', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return json(res, { ok:false, reason:'no OPENAI_API_KEY' }, 503);
  const { auditDealLifecycle } = await import('./engines/lifecycle_audit.js');
  const active = P.db().prepare(`
    SELECT * FROM deals
    WHERE state != 'lost'
      AND funnel_stage NOT IN ('cold','dormant')
      AND (state = 'won' OR funnel_stage IN ('in_works','signed','agreed','active','pitching','conversation'))
    ORDER BY last_activity_at DESC
    LIMIT 100
  `).all();
  let done = 0, failed = 0;
  // Throttle: ~1 audit per second so we don't burst the OpenAI rate limit
  for (const deal of active) {
    try {
      const verdict = await auditDealLifecycle({ db: P.db(), deal, apiKey, spend: P.spend });
      if (verdict) done++; else failed++;
    } catch (e) {
      failed++;
      console.warn('audit-all err for', deal.id, e.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  json(res, { ok:true, scanned: active.length, audited: done, failed });
});

// Bulk-classify brand messages that haven't been tagged yet.
// Adds action_type + authority + requires_response per message so the unread
// chip + plays engine can use the signal. Limited by max so it doesn't blow
// the OpenAI budget — pass ?max=N to do more in one pass.
route('POST', '/api/classify-backfill', async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const max = Math.min(parseInt(url.searchParams.get('max') || '50', 10), 500);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || P.cfg('ai_enabled','false') !== 'true') {
    return json(res, { ok:false, reason:'AI disabled or no key' });
  }
  const { classifyMessage } = await import('./engines/classify_message.js');
  // Pick brand-inbound messages without classification, joined to deals so we
  // can pass deal context to the classifier. Oldest-first so historical state
  // gets backfilled in chronological order.
  const rows = P.db().prepare(`
    SELECT m.id, m.body, m.snippet, m.sent_at,
           d.id AS deal_id, d.brand, d.funnel_stage, d.raw_stage, d.fee_cents, d.obligations
    FROM messages m
    JOIN threads t ON t.id = m.thread_id
    JOIN deals d ON d.id = t.deal_id
    WHERE m.from_us = 0 AND m.classification IS NULL
      AND (m.body IS NOT NULL OR m.snippet IS NOT NULL)
    ORDER BY m.sent_at DESC
    LIMIT ?`).all(max);
  let done = 0, errors = 0;
  for (const r of rows) {
    let obligations = [];
    try { obligations = JSON.parse(r.obligations || '[]'); } catch {}
    try {
      const cls = await classifyMessage({
        apiKey,
        message: { body: r.body, snippet: r.snippet },
        deal: { brand: r.brand, funnel_stage: r.funnel_stage, raw_stage: r.raw_stage, fee_cents: r.fee_cents },
        obligations,
      });
      if (cls) {
        P.db().prepare(`UPDATE messages SET classification=? WHERE id=?`)
          .run(JSON.stringify(cls), r.id);
        done++;
      }
    } catch { errors++; }
  }
  json(res, { ok:true, processed: rows.length, classified: done, errors });
});

// ---- WhatsApp on-demand pull (uses ~/triibe-ops/whatsapp-bridge auth) -------
route('POST', '/api/sync/whatsapp', async (req, res) => {
  // If daemon is alive (even still booting), skip pull.js — they share the session.
  if (await waDaemonAlive()) return json(res, { ok:true, source:'daemon', alive:true });
  const r = await runWhatsAppPull();
  // Reconcile after WA pull too so the message-state truth propagates
  if (r && r.ok !== false) {
    try { reconcileThreadStates({ db: P.db() }); } catch {}
  }
  if (r === null) return json(res, { ok:false, reason:'already running' }, 429);
  json(res, r);
});

// Is the WA daemon ALIVE (HTTP reachable)? — used to decide whether to spawn pull.js.
// We must NOT spawn pull.js if the daemon is up because they share the same
// Chromium session and conflict. Even if daemon is still booting (ready=false),
// it's holding the session — leave it alone.
// Track when the daemon was last seen ready so we can detect stuck initialization
let _daemonLastReadyAt = 0;
async function waDaemonAlive() {
  try {
    const r = await fetch('http://localhost:4745/status', { signal: AbortSignal.timeout(800) });
    if (!r.ok) return false;
    const data = await r.json().catch(() => ({}));
    if (data.ready) {
      _daemonLastReadyAt = Date.now();
      return true;
    }
    // Daemon is responding but not ready. Give it a 2-minute grace period to
    // complete initialization. If still not ready after that, treat as DEAD
    // so pull.js fallback runs and Riley keeps getting messages.
    const stuckMs = Date.now() - _daemonLastReadyAt;
    if (stuckMs < 2 * 60 * 1000) return true; // still booting, leave it alone
    return false; // stuck — let pull.js take over
  } catch { return false; }
}
// For features that need send (must be fully connected, not just alive).
async function waDaemonReady() {
  try {
    const r = await fetch('http://localhost:4745/status', { signal: AbortSignal.timeout(800) });
    if (!r.ok) return false;
    const data = await r.json();
    return !!data.ready;
  } catch { return false; }
}

// Send a WhatsApp message via the daemon. Returns { ok, ... }.
async function waDaemonSend({ chat_name, text }) {
  try {
    const r = await fetch('http://localhost:4745/send', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_name, text }),
      signal: AbortSignal.timeout(15000),
    });
    return await r.json();
  } catch (e) {
    return { ok:false, reason:'WA daemon unreachable — start it with `npm run wa-daemon`: ' + e.message };
  }
}

// ---- WhatsApp SEND (proxies to daemon) --------------------------------------
route('POST', '/api/wa/send', async (req, res) => {
  const { chat_name, text, deal_id } = JSON.parse((await readBody(req)) || '{}');
  if (!chat_name || !text) return json(res, { ok:false, reason:'chat_name + text required' }, 400);
  const r = await waDaemonSend({ chat_name, text });
  if (r.ok && deal_id) {
    P.data.log({ who:'riley', action:'wa_sent', deal_id, summary:`→ ${chat_name}: ${text.slice(0,80)}` });
  }
  json(res, r);
});

route('GET', '/api/wa/status', async (req, res) => {
  // Proxy the daemon's /status so the UI heartbeat can see last_event_at and
  // detect silent stalls (daemon reports ready:true but no messages flow).
  try {
    const r = await fetch('http://localhost:4745/status', { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return json(res, { daemon_ready: false, reachable: false });
    const d = await r.json();
    const lastEventMs = d.last_event_at ? new Date(d.last_event_at).getTime() : null;
    const stale_seconds = lastEventMs ? Math.floor((Date.now() - lastEventMs) / 1000) : null;
    json(res, {
      daemon_ready: !!d.ready,
      reachable: true,
      last_event_at: d.last_event_at || null,
      stale_seconds,
      qr_pending: !!d.qr_pending,
    });
  } catch (e) {
    json(res, { daemon_ready: false, reachable: false, error: e.message });
  }
});

// One-tap restart for the WA daemon — for when the UI flags it as stalled.
// Uses launchctl to kick the launchd-managed service so auth state survives.
route('POST', '/api/wa/restart', async (req, res) => {
  try {
    const { exec } = await import('node:child_process');
    await new Promise((resolve, reject) => {
      exec(`launchctl kickstart -k gui/$(id -u)/com.triibe.platform.whatsapp`,
        { timeout: 8_000 }, (err) => err ? reject(err) : resolve());
    });
    json(res, { ok: true });
  } catch (e) {
    json(res, { ok: false, error: e.message }, 500);
  }
});

// ---- Freshness ---------------------------------------------------------------
route('GET', '/api/freshness', async (req, res) => {
  const snap = `${ROOT}/migration/source/deals.snapshot.json`;
  try {
    const { stdout } = await pexec('bash', ['-c', `stat -f '%m' "${snap}"`]);
    const mtime = parseInt(stdout.trim(), 10) * 1000;
    const ageMs = Date.now() - mtime;
    json(res, { snapshot_mtime: new Date(mtime).toISOString(), age_seconds: Math.round(ageMs/1000) });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// ---- Spend / AI control ----------------------------------------------------
route('GET', '/api/spend', async (req, res) => json(res, P.spend.status()));
route('POST', '/api/spend/kill', async (req, res) => {
  P.db().prepare(`UPDATE config SET value='false', updated_at=datetime('now') WHERE key='ai_enabled'`).run();
  P.reload();
  json(res, { ok:true, ai_enabled:false });
});
route('POST', '/api/ai/toggle', async (req, res) => {
  const body = JSON.parse((await readBody(req)) || '{}');
  const want = body.enabled ? 'true' : 'false';
  if (want === 'true' && !process.env.OPENAI_API_KEY)
    return json(res, { ok:false, reason:'OPENAI_API_KEY missing — paste it into .env and restart the server first.' }, 400);
  P.db().prepare(`UPDATE config SET value=?, updated_at=datetime('now') WHERE key='ai_enabled'`).run(want);
  P.db().prepare(`UPDATE config SET value=?, updated_at=datetime('now') WHERE key='draft_provider'`).run(want === 'true' ? 'openai' : 'local-stub');
  P.reload();
  json(res, { ok:true, ai_enabled: want === 'true', provider: want === 'true' ? 'openai:gpt-4o' : 'local-stub' });
});

// All attachments (email + WhatsApp) tied to a deal, via its threads. Plus any
// contracts uploaded directly. Sorted newest-first. Used by the Attachments
// strip in the expanded pill.
route('GET', '/api/deals/([^/]+)/attachments', async (req, res, { match }) => {
  const dealId = match[1];
  const fromThreads = P.db().prepare(`
    SELECT a.id, a.message_id, a.thread_id, a.channel, a.media_path, a.media_filename,
           a.media_mime, a.media_size, a.media_type, a.created_at,
           m.sent_at, m.sender
    FROM message_attachments a
    JOIN messages m ON m.id = a.message_id
    JOIN threads  t ON t.id = a.thread_id
    WHERE t.deal_id = ?
    ORDER BY m.sent_at DESC`).all(dealId);
  // Contracts uploaded via the drop zone (separate path)
  const contracts = P.db().prepare(`
    SELECT id, file_path AS media_path, status, fee_cents, created_at
    FROM contracts WHERE deal_id = ? ORDER BY created_at DESC`).all(dealId);
  json(res, {
    attachments: fromThreads.map(a => ({
      ...a,
      url: '/' + a.media_path,
      from_brand: a.sender && !/(@gmail\.com.*Riley|wallackj|riley@)/i.test(a.sender || ''),
    })),
    contracts: contracts.map(c => {
      const base = c.media_path.split('/').pop() || '';
      // Strip leading timestamp prefix ("1780781138364-Mirage-Cooper-Signed.pdf" → "Mirage-Cooper-Signed.pdf")
      const display = base.replace(/^\d{10,}-/, '');
      return {
        ...c,
        url: '/' + c.media_path.replace(/^.*\/contracts\//, 'contracts/'),
        media_filename: display,
        kind: 'contract',
      };
    }),
  });
});

// Tunnel info — reads config/tunnel.json which the tunnel-runner script writes
// each time it captures a fresh public URL. Used by topbar so Riley can always
// find / share the current cellular URL.
route('GET', '/api/system/tunnel', async (req, res) => {
  try {
    const fs = await import('node:fs');
    const path = '/Users/rileywallack/triibe-platform/config/tunnel.json';
    if (!fs.existsSync(path)) return json(res, { ok:false, reason:'no tunnel running' });
    const data = JSON.parse(fs.readFileSync(path, 'utf8'));
    json(res, { ok:true, ...data });
  } catch (e) { json(res, { ok:false, reason: e.message }); }
});

// Update deal state — used by Today's Plays "walk away" action
route('POST', '/api/deals/([^/]+)/state', async (req, res, { match }) => {
  const dealId = match[1];
  const body = JSON.parse((await readBody(req)) || '{}');
  if (!['open','won','lost','dormant'].includes(body.state))
    return json(res, { ok:false, reason:'invalid state' }, 400);
  P.db().prepare(`UPDATE deals SET state=?, updated_at=datetime('now') WHERE id=?`)
    .run(body.state, dealId);
  P.data.log({ who:'riley', action:'state_change', deal_id: dealId, summary:`→ ${body.state}` });
  json(res, { ok:true });
});

// ---- This Week — concrete deliverables for booked deals ----------------
// Surfaces sign/deliver/post/invoice actions for each active deal so Riley
// sees the checklist of contractual work, not just brand signals.
route('GET', '/api/this-week', async (req, res, { url }) => {
  const creator = url.searchParams.get('creator');
  if (!creator) return json(res, { deals: [] });
  const { buildThisWeek } = await import('./engines/this_week.js');
  const { autoParkStaleDeals } = await import('./engines/auto_park.js');
  const apiKey = (P.cfg('ai_enabled','false') === 'true') ? process.env.OPENAI_API_KEY : null;
  // Park revival — flip any dormant deal whose revisit date is here into 'open'
  // BEFORE building this-week, so revived deals show up in Pitches the moment
  // their wait period ends. Idempotent + cheap (single indexed UPDATE).
  try { revivePastDueParked(P.db()); } catch {}
  // Auto-park sweeper — opposite side of the revival coin. Quietly parks deals
  // where brand has been silent ≥14d after ≥2 unanswered nudges, so Riley's
  // pipeline doesn't accumulate dead-but-not-marked threads. Idempotent: only
  // touches state=open deals matching the rule.
  let autoParked = { parked: [], count: 0 };
  try { autoParked = autoParkStaleDeals(P.db()); } catch (e) { console.error('auto_park:', e.message); }
  const data = await buildThisWeek({ db: P.db(), creator, apiKey, stripQuotedReply });
  // Surface auto-park result on the response so the UI can show "3 deals parked"
  if (autoParked.count) data.auto_parked = autoParked.parked;

  // Merge in deals with real money in motion → "Close These Deals":
  //   A. Rate-pitched with a brand $ counter on the table
  //   B. Rate-pitched where WE put a $ down and brand has engaged within 14 days
  //   C. Conversation-stage deals where we have a fee_cents on file and brand
  //      activity is recent (catches Accio-style "we quoted, brand mulling")
  // Everything that's actively closeable lives here regardless of funnel_stage.
  try {
    const rpRes = await fetch(`http://localhost:${PORT}/api/rate-pitched?creator=${encodeURIComponent(creator)}`);
    const rpData = await rpRes.json();
    const existingIds = new Set([
      ...(data.deals || []).map(d => d.deal_id),
      ...(data.pending || []).map(d => d.deal_id),
    ]);
    const now = Date.now();
    const ACTIVE_DAYS = 14;
    const recent = (iso) => iso && (now - new Date(iso).getTime()) / 86400000 < ACTIVE_DAYS;

    // --- A + B: from rate-pitched, anything with money in motion AND brand engaged ---
    const promoted = (rpData || [])
      .filter(d => {
        if (existingIds.has(d.id)) return false;
        if (d.brand_counter_cents) return true;                    // A: counter on table
        if (d.our_quote_cents && recent(d.latest_brand_at)) return true; // B: our $ + brand alive
        return false;
      })
      .map(d => {
        const counterUSD = d.brand_counter_cents ? Math.round(d.brand_counter_cents / 100).toLocaleString() : null;
        const ourUSD = d.our_quote_cents ? Math.round(d.our_quote_cents / 100).toLocaleString() : null;
        const deltaPct = d.counter_delta_pct;
        let label, detail;
        if (counterUSD) {
          label = 'Counter or accept';
          detail = ourUSD
            ? `Brand countered $${counterUSD} vs our $${ourUSD}${deltaPct != null ? ` (${deltaPct>0?'+':''}${deltaPct}%)` : ''}`
            : `Brand countered $${counterUSD}`;
        } else {
          label = 'Close — push to yes';
          detail = `We quoted $${ourUSD} — brand engaged but hasn't committed yet`;
        }
        return {
          deal_id: d.id, brand: d.brand,
          fee_cents: d.fee_cents || d.our_quote_cents,
          raw_stage: d.raw_stage, funnel_stage: d.funnel_stage, state: d.state,
          posting_date: d.posting_date,
          key_dates: { post: d.posting_date || null, script_due: null, delivery: null, payment_due: null, sign_by: null },
          actions: [{ kind: 'respond_to_brand', label, detail, tier: 'amber',
            date_label: counterUSD ? 'on table' : 'live', days_out: 0,
            completed: false, completed_at: null }],
          open_count: 1, completed_count: 0, next_action_at: 0,
        };
      });

    // --- C: conversation-stage deals where we have a fee + brand active recently ---
    const convQuery = P.db().prepare(`
      SELECT id, brand, fee_cents, raw_stage, funnel_stage, state, posting_date,
             last_activity_at, last_activity_by, ball_in_court
      FROM deals
      WHERE creator_id = ?
        AND funnel_stage = 'conversation'
        AND state = 'open'
        AND (managed_by IS NULL OR managed_by = 'riley')
        AND fee_cents IS NOT NULL AND fee_cents > 0
      ORDER BY last_activity_at DESC`);
    const convDeals = convQuery.all(creator)
      .filter(d => !existingIds.has(d.id) && recent(d.last_activity_at))
      .map(d => {
        const ourUSD = Math.round(d.fee_cents / 100).toLocaleString();
        return {
          deal_id: d.id, brand: d.brand,
          fee_cents: d.fee_cents,
          raw_stage: d.raw_stage, funnel_stage: d.funnel_stage, state: d.state,
          posting_date: d.posting_date,
          key_dates: { post: d.posting_date || null, script_due: null, delivery: null, payment_due: null, sign_by: null },
          actions: [{ kind: 'respond_to_brand', label: 'Close — push to yes',
            detail: `We quoted $${ourUSD} — brand still considering`,
            tier: 'amber', date_label: 'live', days_out: 0,
            completed: false, completed_at: null }],
          open_count: 1, completed_count: 0, next_action_at: 0,
        };
      });

    const allPromoted = [...promoted, ...convDeals];
    if (allPromoted.length) {
      data.pending = [...(data.pending || []), ...allPromoted];
    }
    // ---- CLOSE-SCORE RANK: sort Close These Deals best→worst ----
    // Each pending deal gets a 1-10 score based on $ on table, stage closeness,
    // brand recency, exclusivity clash risk, category saturation. Sort by score
    // descending so the closest-to-close deals float to the top.
    if ((data.pending || []).length) {
      const allActiveDeals = P.db().prepare(`SELECT * FROM deals WHERE state IN ('open','won')`).all();
      // Map deal_id → enriched negotiation data from rate-pitched query
      const rpById = {};
      for (const r of (rpData || [])) rpById[r.id] = r;
      for (const p of data.pending) {
        // Pull full deal row + neg data (counter, our quote, latest brand reply)
        const deal = P.db().prepare(`SELECT * FROM deals WHERE id=?`).get(p.deal_id) || p;
        const neg = rpById[p.deal_id] || {};
        try {
          const cs = computeCloseScore({
            deal,
            negData: {
              our_quote_cents: neg.our_quote_cents,
              brand_counter_cents: neg.brand_counter_cents,
              counter_delta_pct: neg.counter_delta_pct,
              latest_brand_at: neg.latest_brand_at || deal.last_activity_at,
            },
            ctx: { db: P.db(), allActiveDeals, creatorId: creator },
          });
          p.close_score = cs.score;
          p.close_headline = cs.headline;
          p.close_reasons = cs.reasons;
          p.close_blocked = cs.blocked;
        } catch {}
        // Surface the AI summary so the Pitches card can show a 1-2 sentence
        // "what brand said last + what I replied" without expanding the pill.
        // Engine that writes this field is summary-engine A+B+C (task #157).
        p.ai_summary = deal.ai_summary || null;
      }
      // Chase tagging — annotate EVERY pending deal (not just the ones built
      // by buildThisWeek; the rate-pitched promoted ones get appended above
      // without the engine-side tag). Same rules as the standalone chase queue:
      // $1K+ + ball-on-us 4-30d OR ball-on-brand 5-21d.
      const DAY = 86400_000;
      for (const p of data.pending) {
        const deal = P.db().prepare(`SELECT ball_in_court, last_activity_at FROM deals WHERE id=?`).get(p.deal_id);
        if (!deal || !deal.last_activity_at) continue;
        if ((p.fee_cents || 0) < 100_000) continue;
        const daysQuiet = Math.floor((Date.now() - new Date(deal.last_activity_at).getTime()) / DAY);
        const ballUs    = deal.ball_in_court === 'us' || deal.ball_in_court === 'riley';
        const ballBrand = deal.ball_in_court === 'brand';
        if (ballUs && daysQuiet >= 4 && daysQuiet <= 30) {
          p.chase = { kind: 'we_owe', days_quiet: daysQuiet };
        } else if (ballBrand && daysQuiet >= 5 && daysQuiet <= 21) {
          p.chase = { kind: 'stalled', days_quiet: daysQuiet };
        }
      }
      data.pending.sort((a, b) => {
        // Blocked deals sink to the bottom regardless of anything else
        if (a.close_blocked !== b.close_blocked) return a.close_blocked ? 1 : -1;
        // Chase candidates float to top: we_owe before stalled before normal
        const chaseRank = (x) => x.chase?.kind === 'we_owe' ? 0
                              : x.chase?.kind === 'stalled' ? 1
                              : 2;
        const ra = chaseRank(a), rb = chaseRank(b);
        if (ra !== rb) return ra - rb;
        // Within same chase tier: highest fee first for chase deals (money on
        // the table dominates); close_score then fee for normal deals.
        if (ra < 2) return (b.fee_cents || 0) - (a.fee_cents || 0);
        const aS = a.close_score ?? 5;
        const bS = b.close_score ?? 5;
        if (aS !== bS) return bS - aS;
        return (b.fee_cents || 0) - (a.fee_cents || 0);
      });
    }
  } catch (e) {
    // Non-fatal — if merge fails, return whatever buildThisWeek gave us
  }

  // Enrich each deal with unread_reply: when the latest thread message is from
  // the brand AND ball is on us, surface sender + age so the UI can show a
  // "📧 Silvija replied 4d ago" chip directly on the deal pill. SUPPRESS the
  // chip when the AI classifier knows the brand message is FYI / payment_chase
  // confirmation / no-reply-needed (e.g. "thanks, sent via Lumanu" doesn't
  // need a reply — surfacing it as urgent unread is noise).
  try {
    const allIds = [...(data.deals || []), ...(data.pending || [])].map(d => d.deal_id);
    if (allIds.length) {
      const placeholders = allIds.map(() => '?').join(',');
      const unreadRows = P.db().prepare(`
        SELECT t.deal_id, t.last_message_at, t.last_message_by, t.channel,
               (SELECT m.sender FROM messages m WHERE m.thread_id=t.id AND m.from_us=0
                ORDER BY m.sent_at DESC LIMIT 1) AS brand_sender,
               (SELECT m.sent_at FROM messages m WHERE m.thread_id=t.id AND m.from_us=0
                ORDER BY m.sent_at DESC LIMIT 1) AS brand_sent_at,
               (SELECT m.classification FROM messages m WHERE m.thread_id=t.id AND m.from_us=0
                ORDER BY m.sent_at DESC LIMIT 1) AS brand_classification,
               (SELECT m.body FROM messages m WHERE m.thread_id=t.id AND m.from_us=0
                ORDER BY m.sent_at DESC LIMIT 1) AS brand_body
        FROM threads t
        WHERE t.deal_id IN (${placeholders})
          AND t.ball_in_court = 'us'
          AND t.last_message_by = 'them'
          AND t.last_message_at = (
            SELECT MAX(t2.last_message_at) FROM threads t2 WHERE t2.deal_id = t.deal_id
          )`).all(...allIds);
      const byDeal = {};
      for (const r of unreadRows) byDeal[r.deal_id] = r;
      const attachUnread = (d) => {
        const u = byDeal[d.deal_id];
        if (!u || !u.brand_sent_at) return;
        // Skip chip when AI classifier says no response needed (FYI, payment
        // confirmations like "sent via Lumanu", etc.). But still surface a
        // "payment in flight" badge separately if it's payment-related.
        let cls = null;
        try { cls = u.brand_classification ? JSON.parse(u.brand_classification) : null; } catch {}
        if (cls && cls.requires_response === false) {
          // Detect payment-in-flight signals so Riley sees "💰 Payment routing
          // via Lumanu" instead of a useless unread chip.
          const body = (u.brand_body || '').toLowerCase();
          const isPaymentRouting = cls.action_type === 'payment_chase'
            && /(lumanu|wise|payoneer|stripe|tipalti|tax form|w[-]?9|payment details|invoice (sent|processed|received)|paid via|payout)/i.test(body);
          if (isPaymentRouting) {
            const sender = (u.brand_sender || '').split('<')[0].trim().slice(0, 30) || 'brand';
            const platform = /lumanu/i.test(body) ? 'Lumanu'
                          : /wise/i.test(body) ? 'Wise'
                          : /payoneer/i.test(body) ? 'Payoneer'
                          : /stripe/i.test(body) ? 'Stripe'
                          : /tipalti/i.test(body) ? 'Tipalti'
                          : 'their payment platform';
            d.payment_in_flight = { sender, platform, sent_at: u.brand_sent_at };
          }
          return;  // suppress regular unread chip
        }
        const sender = (u.brand_sender || '').split('<')[0].trim().slice(0, 30) || 'brand';
        const ageH = Math.round((Date.now() - new Date(u.brand_sent_at).getTime()) / 3600000);
        d.unread_reply = { sender, channel: u.channel, age_hours: ageH, sent_at: u.brand_sent_at };
      };
      (data.deals || []).forEach(attachUnread);
      (data.pending || []).forEach(attachUnread);
    }
  } catch {}

  // Enrich with last_outbound: when did Riley last reply / nudge this deal?
  // Drives the "✓ You replied 3h ago" freshness chip on each pill, so Riley
  // can see at a glance which deals he's already acted on today vs which
  // are still waiting on him. CRITICAL for the "platform tells me what I did"
  // trust signal — without it the Close These Deals tray looks like nothing
  // moved even after Riley fires 5 nudges.
  try {
    const allIds = [...(data.deals || []), ...(data.pending || [])].map(d => d.deal_id);
    if (allIds.length) {
      const placeholders = allIds.map(() => '?').join(',');
      const outboundRows = P.db().prepare(`
        SELECT t.deal_id,
               (SELECT m.sent_at FROM messages m WHERE m.thread_id=t.id AND m.from_us=1
                ORDER BY m.sent_at DESC LIMIT 1) AS sent_at,
               (SELECT m.channel FROM messages m WHERE m.thread_id=t.id AND m.from_us=1
                ORDER BY m.sent_at DESC LIMIT 1) AS channel,
               (SELECT m.snippet FROM messages m WHERE m.thread_id=t.id AND m.from_us=1
                ORDER BY m.sent_at DESC LIMIT 1) AS snippet
        FROM threads t
        WHERE t.deal_id IN (${placeholders})
          AND EXISTS (SELECT 1 FROM messages m2 WHERE m2.thread_id=t.id AND m2.from_us=1)
      `).all(...allIds);
      // Multiple threads can exist per deal — pick the most recent outbound across all threads
      const lastByDeal = {};
      for (const r of outboundRows) {
        if (!r.sent_at) continue;
        const ex = lastByDeal[r.deal_id];
        if (!ex || new Date(r.sent_at) > new Date(ex.sent_at)) lastByDeal[r.deal_id] = r;
      }
      const attachOutbound = (d) => {
        const o = lastByDeal[d.deal_id];
        if (!o || !o.sent_at) return;
        const ageMs = Date.now() - new Date(o.sent_at).getTime();
        const ageH = Math.round(ageMs / 3600000);
        // Only surface if within 72h — anything older isn't really "freshness"
        if (ageH > 72) return;
        // Detect intent from the outbound snippet so the chip can say "Nudged"
        // vs "Replied" vs "Sent rate" (small UX touch, no AI needed)
        const snip = (o.snippet || '').toLowerCase();
        let kind = 'Replied';
        if (/just checking in|circling back|following up|checking back/i.test(snip)) kind = 'Nudged';
        else if (/here's the rate|standard rate|cooper's rate|charlie's rate|\$\d/i.test(snip) && /(starting at|rate|breakdown)/i.test(snip)) kind = 'Quoted';
        else if (/decline|unfortunately|budget|below where we can place|below our floor/i.test(snip)) kind = 'Declined';
        d.last_outbound = { age_hours: ageH, channel: o.channel || 'email', kind, sent_at: o.sent_at };
      };
      (data.deals || []).forEach(attachOutbound);
      (data.pending || []).forEach(attachOutbound);
    }
  } catch {}

  // Replace each deal's terse "next 1-2 actions" with the FULL lifecycle
  // pipeline (negotiate → script → film → draft → post → invoice → pay).
  // Statuses (done/active/waiting/todo) are auto-inferred from last_outbound,
  // unread_reply, posting_date, payment_in_flight — so as deal state advances,
  // the checklist auto-rolls forward without manual intervention.
  try {
    const { buildLifecycle } = await import('./engines/lifecycle.js');
    const applyLifecycle = (d) => {
      const steps = buildLifecycle(d);
      if (steps && steps.length) {
        // Preserve action counts the UI shows in the header
        d.actions = steps;
        d.open_count = steps.filter(s => !s.completed).length;
        d.completed_count = steps.filter(s => s.completed).length;
      }
    };
    (data.deals || []).forEach(applyLifecycle);
    (data.pending || []).forEach(applyLifecycle);
  } catch (e) {
    console.warn('lifecycle expansion failed:', e.message);
  }

  json(res, data);
});

// Tick / untick a checklist action
route('POST', '/api/this-week/(complete|uncomplete)', async (req, res, { match }) => {
  const action = match[1];
  const body = JSON.parse((await readBody(req)) || '{}');
  if (!body.deal_id || !body.action_kind)
    return json(res, { ok:false, reason:'deal_id + action_kind required' }, 400);
  const mod = await import('./engines/this_week.js');
  if (action === 'complete')   json(res, mod.completeAction({ db: P.db(), ...body }));
  else                          json(res, mod.uncompleteAction({ db: P.db(), ...body }));
});

// ---- Today's Plays — the AI brain ---------------------------------------
// Aggregates signals, AI re-ranks them, returns 5-7 top actions.
// In-memory cache: 5 min, keyed by creator. Bypass with ?force=1.
const PLAYS_CACHE = new Map();
route('GET', '/api/plays', async (req, res, { url }) => {
  const creator = url.searchParams.get('creator') || null;
  const force = url.searchParams.get('force') === '1';
  const key = creator || 'all';
  const cached = PLAYS_CACHE.get(key);
  if (!force && cached && (Date.now() - cached.at) < 5 * 60_000) {
    return json(res, { ...cached.data, cached: true, age_sec: Math.round((Date.now() - cached.at)/1000) });
  }
  const { gatherSignals, rankWithAI } = await import('./engines/plays.js');
  const raw = gatherSignals({ db: P.db(), creator });
  // Run AI rank only if AI is on AND we have enough signals to make ranking worthwhile
  let plays = raw.slice(0, 7);
  if (raw.length >= 3 && process.env.OPENAI_API_KEY && P.cfg('ai_enabled','false') === 'true') {
    plays = await rankWithAI({ signals: raw, apiKey: process.env.OPENAI_API_KEY, creator });
  }
  const data = {
    plays,
    fyi: raw.fyi || [],  // soft-asks / brand FYI items separated from main plays
    total_signals: raw.length,
    total_value_cents: raw.reduce((a, s) => a + (s.value_cents || 0), 0),
    generated_at: new Date().toISOString(),
  };
  PLAYS_CACHE.set(key, { at: Date.now(), data });
  json(res, data);
});

// Per-deal fit score (1-10) — for Rate Pitched + leads view.
// Pure computation, no AI cost.
route('GET', '/api/deals/([^/]+)/fit-score', async (req, res, { match }) => {
  const deal = P.data.getDeal(match[1]);
  if (!deal) return json(res, { error: 'not found' }, 404);
  json(res, computeFitScore({ deal, db: P.db() }));
});

// Per-deal rate negotiation parse — what's actually on the table.
// Pulls latest brand msg + latest outbound, strips Gmail quoted-reply chains
// (otherwise our prior $ leaks into the brand body), extracts $ figures.
// When brand's number matches our ask, marks accepted=true so the UI can render
// "Brand accepted $X" instead of duplicating the figure as a "counter".
route('GET', '/api/deals/([^/]+)/negotiation', async (req, res, { match }) => {
  const deal = P.data.getDeal(match[1]);
  if (!deal) return json(res, { error: 'not found' }, 404);

  const lb = P.db().prepare(`
    SELECT m.body, m.snippet, m.sent_at, m.channel
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE t.deal_id = ? AND m.from_us = 0
    ORDER BY m.sent_at DESC LIMIT 1`).get(deal.id);
  const lo = P.db().prepare(`
    SELECT m.body, m.snippet, m.sent_at, m.channel
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE t.deal_id = ? AND m.from_us = 1
    ORDER BY m.sent_at DESC LIMIT 1`).get(deal.id);

  const clean = (m) => {
    if (!m) return '';
    let b = m.body || m.snippet || '';
    if (m.channel === 'email' && b) { try { b = stripQuotedReply(b) || b; } catch {} }
    return b;
  };
  const lbClean = clean(lb);
  const loClean = clean(lo);

  // Highest $ figure in our last outbound — almost always the rate we proposed
  // (catches deals where Riley pitched without setting fee_cents on the row).
  const highestDollar = (text) => {
    if (!text) return null;
    const m = [...text.matchAll(/\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)(?!\d)/g)]
      .map(x => Math.round(parseFloat(x[1].replace(/,/g,''))*100))
      .filter(c => c >= 30000 && c <= 5000000);
    return m.length ? Math.max(...m) : null;
  };
  const detectedFromOurs = highestDollar(loClean);
  const ourCents = deal.fee_cents || detectedFromOurs || null;
  const brandCents = highestDollar(lbClean);

  // Distinguish accepted-our-rate from countered.
  // Accepted: brand $ within 1% of our ask. Countered: different number.
  let accepted = false, counterCents = null, deltaPct = null;
  if (brandCents && ourCents) {
    const diff = Math.abs(brandCents - ourCents) / ourCents;
    if (diff <= 0.01) {
      accepted = true;
    } else {
      counterCents = brandCents;
      deltaPct = Math.round((brandCents - ourCents) / ourCents * 100);
    }
  }

  json(res, {
    deal_id: deal.id,
    our_quote_cents: ourCents,
    our_quote_inferred: !deal.fee_cents && !!detectedFromOurs,
    brand_counter_cents: counterCents,
    counter_delta_pct: deltaPct,
    brand_accepted: accepted,
    last_brand_at: lb?.sent_at || null,
    last_our_at: lo?.sent_at || null,
  });
});

function computeFitScore({ deal, db }) {
  // Pull rate card for this creator
  const card = (deal.creator_id && RATE_CARD[deal.creator_id]) || {};
  let score = 50;  // start neutral
  const reasons = [];
  // (1) Rate vs floor (-30 to +30)
  if (deal.fee_cents && card.floor_cents) {
    const ratio = deal.fee_cents / card.floor_cents;
    if (ratio >= 1.4)      { score += 30; reasons.push(`✓ $${(deal.fee_cents/100).toLocaleString()} is ${Math.round((ratio-1)*100)}% above floor`); }
    else if (ratio >= 1.0) { score += 15; reasons.push(`✓ $${(deal.fee_cents/100).toLocaleString()} meets floor`); }
    else if (ratio >= 0.7) { score -= 15; reasons.push(`⚠ Below floor (${Math.round((1-ratio)*100)}% short)`); }
    else                    { score -= 30; reasons.push(`✗ Far below floor — likely walk-away`); }
  } else if (!deal.fee_cents) {
    reasons.push(`? No rate locked yet`);
  }
  // (2) Exclusivity (-15 to +15)
  const exDays = deal.exclusivity_days || 0;
  if (exDays === 0)         { score += 15; reasons.push(`✓ No exclusivity ask`); }
  else if (exDays <= 30)    { score += 5;  reasons.push(`◐ ${exDays}d exclusivity — acceptable`); }
  else if (exDays <= 60)    { score -= 5;  reasons.push(`⚠ ${exDays}d exclusivity — push back`); }
  else                       { score -= 15; reasons.push(`✗ ${exDays}d exclusivity — redline`); }
  // (3) Stage progression (+5 to +15)
  const stageBonus = { conversation: 5, pitching: 8, in_works: 13, active: 15, completed: 15 };
  score += stageBonus[deal.funnel_stage] || 0;
  // (4) Category concentration check
  const allDeals = db.prepare(`SELECT * FROM deals WHERE creator_id=? AND state IN ('open','won')`).all(deal.creator_id);
  const sameCategory = allDeals.filter(d => d.id !== deal.id && d.category && d.category === deal.category);
  if (sameCategory.length > 3) { score -= 10; reasons.push(`⚠ ${sameCategory.length} other ${deal.category} deals active — category concentration`); }
  // (5) Days idle penalty
  if (deal.days_idle && deal.days_idle > 14) {
    score -= 10; reasons.push(`⚠ ${deal.days_idle}d idle — going cold`);
  }
  // Normalize to 1-10
  const tenScore = Math.max(1, Math.min(10, Math.round(score / 10)));
  const verdict = tenScore >= 8 ? 'strong' : tenScore >= 5 ? 'fair' : tenScore >= 3 ? 'weak' : 'walk-away';
  return { score: tenScore, raw: score, verdict, reasons };
}

// ---- Rate Pitched (pitching-stage deals: our quote vs brand counter) -------
// Surfaces deals where we sent a rate and are now waiting on brand OR brand
// already came back with a number. Drives the section under Active Deals.
// Follow-ups view — the "passive waiting" parking lot. Includes:
//   A. Rate-pitched deals where brand went silent (no counter, no recent reply).
//      Deals WITH counter OR active engagement get pulled into Close These Deals.
//   B. Conversation-stage deals with NO money in motion (Poppy-AI-style
//      scheduling, intros, etc.) — relationship maintenance, not closing.
// Sorted: most-recently-touched first, so what's still warm rises.
route('GET', '/api/follow-ups', async (req, res, { url }) => {
  const creator = url.searchParams.get('creator') || null;
  const ACTIVE_DAYS = 14;
  const now = Date.now();
  const recent = (iso) => iso && (now - new Date(iso).getTime()) / 86400000 < ACTIVE_DAYS;

  // STRICT BALL-IN-COURT SPLIT: Follow Ups = ball is on the brand (we're
  // waiting). The moment the brand replies → reconcile flips ball=us →
  // deal auto-moves to Inbox. The moment Riley replies → ball=them → deal
  // auto-moves back here. One source of truth per state.
  const onUs = new Set(
    P.db().prepare(`SELECT id FROM deals WHERE ball_in_court='us'`).all().map(r => r.id)
  );

  // A: rate-pitched without active engagement AND ball not on us
  const rpRes = await fetch(`http://localhost:${PORT}/api/rate-pitched${creator ? '?creator=' + creator : ''}`);
  const rpData = await rpRes.json();
  const ratePitchedSilent = (rpData || []).filter(d => {
    if (d.brand_counter_cents) return false;                          // → Close These Deals
    if (d.our_quote_cents && recent(d.latest_brand_at)) return false; // → Close These Deals
    if (onUs.has(d.id)) return false;                                 // → Inbox (we owe a reply)
    return true;
  });

  // B: conversation-stage deals with no money in motion AND ball not on us
  const convDeals = P.db().prepare(`
    SELECT * FROM deals
    WHERE funnel_stage = 'conversation' AND state = 'open'
      AND (managed_by IS NULL OR managed_by = 'riley')
      AND (fee_cents IS NULL OR fee_cents = 0)
      AND (ball_in_court IS NULL OR ball_in_court != 'us')
      ${creator ? "AND creator_id = ?" : ""}
    ORDER BY last_activity_at DESC`).all(...(creator ? [creator] : []));

  // Tag each with a "kind" so the UI can show them in subtle groups.
  // Sort: OLDEST FIRST so the stalest brands float to the top (replaces the
  // need for a separate "Going stale" filter in Inbox).
  // NOTE: signed/in-works confirmed deals stay on Today's This Week — they're
  // not duplicated here. The unread chip on the pill handles brand activity.
  const tagged = [
    ...ratePitchedSilent.map(d => ({ ...d, _followup_kind: 'rate_silent' })),
    ...convDeals.map(d => ({ ...d, _followup_kind: 'conversation' })),
  ].sort((a, b) => {
    const aT = a.latest_brand_at || a.last_activity_at || '9999';
    const bT = b.latest_brand_at || b.last_activity_at || '9999';
    return aT.localeCompare(bT);
  });

  json(res, tagged);
});

route('GET', '/api/rate-pitched', async (req, res, { url }) => {
  const creator = url.searchParams.get('creator') || null;
  const deals = P.data.listDeals({ creator, limit: 2000 })
    .filter(d => d.funnel_stage === 'pitching' && d.state !== 'lost');
  // For each deal: find brand's latest message + our latest outbound, extract $ figures
  const ids = deals.map(d => d.id);
  const latestBrand = ids.length ? Object.fromEntries(P.db().prepare(`
    SELECT t.deal_id, m.body, m.snippet, m.sent_at FROM messages m
    JOIN threads t ON t.id = m.thread_id
    WHERE t.deal_id IN (${ids.map(()=>'?').join(',')})
      AND m.from_us = 0
      AND m.id IN (SELECT id FROM messages WHERE thread_id=t.id AND from_us=0
                   ORDER BY sent_at DESC LIMIT 1)
    GROUP BY t.deal_id`).all(...ids).map(r => [r.deal_id, r])) : {};
  // Our latest outbound — used to AUTO-DETECT what we pitched when fee_cents
  // isn't logged. We scan Riley's latest message for the highest $ figure;
  // that's almost always the rate we proposed.
  const latestOurs = ids.length ? Object.fromEntries(P.db().prepare(`
    SELECT t.deal_id, m.body, m.snippet, m.sent_at FROM messages m
    JOIN threads t ON t.id = m.thread_id
    WHERE t.deal_id IN (${ids.map(()=>'?').join(',')})
      AND m.from_us = 1
      AND m.id IN (SELECT id FROM messages WHERE thread_id=t.id AND from_us=1
                   ORDER BY sent_at DESC LIMIT 1)
    GROUP BY t.deal_id`).all(...ids).map(r => [r.deal_id, r])) : {};

  // Helper: find HIGHEST $ amount in text (our pitched rate is typically the
  // biggest number we mentioned — beats counter offers and small references).
  const highestDollar = (text) => {
    if (!text) return null;
    const matches = [...text.matchAll(/\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)(?!\d)/g)]
      .map(m => Math.round(parseFloat(m[1].replace(/,/g,''))*100))
      .filter(c => c >= 30000 && c <= 5000000);  // $300 to $50k — sane band
    return matches.length ? Math.max(...matches) : null;
  };

  const enriched = deals.map(d => {
    const lb = latestBrand[d.id];
    const lo = latestOurs[d.id];
    // Strip quoted-reply chains before scanning $ figures — otherwise our own
    // counter-offer leaks into the brand's body via Gmail's "On ... wrote:"
    // quote block and gets misread as a brand counter.
    let lbBody = lb?.body || lb?.snippet || '';
    if (lbBody) { try { lbBody = stripQuotedReply(lbBody) || lbBody; } catch {} }
    let loBody = lo?.body || lo?.snippet || '';
    if (loBody) { try { loBody = stripQuotedReply(loBody) || loBody; } catch {} }
    const counterCents = lbBody ? extractDollarCents(lbBody) : null;
    // Our pitched rate: prefer explicit fee_cents on deal, fall back to highest
    // $ we mentioned in our latest outbound. This catches deals where Riley
    // pitched verbally without updating the deal row.
    const detectedFromOurMsg = loBody ? highestDollar(loBody) : null;
    const ourCents = d.fee_cents || detectedFromOurMsg;
    const hasCounter = counterCents && ourCents && counterCents !== ourCents;
    const counterDelta = (hasCounter && ourCents)
      ? Math.round((counterCents - ourCents) / ourCents * 100)
      : null;
    return {
      ...d,
      our_quote_cents: ourCents,
      our_quote_inferred: !d.fee_cents && !!detectedFromOurMsg,  // tells UI we guessed
      brand_counter_cents: hasCounter ? counterCents : null,
      counter_delta_pct: counterDelta,
      latest_brand_msg: lb?.body?.slice(0, 280) || lb?.snippet || null,
      latest_brand_at: lb?.sent_at || null,
    };
  })
  // FILTER: keep any deal where we've quoted a rate AND the brand has been
  // alive in the thread at some point. Routing into Close These Deals vs.
  // Follow Ups happens downstream — we just need to include everything with
  // real money in the conversation so nothing leaks through the cracks.
  //   - negotiating / terms_agreed_pending_client → real back-and-forth, always include
  //   - rate_sent → include if brand has replied at any point (regardless of ball);
  //     silent "ball on brand" deals (Summary AI, Abacus AI) belong in Follow Ups.
  .filter(d => {
    if (['negotiating','terms_agreed_pending_client'].includes(d.raw_stage)) return true;
    if (d.raw_stage === 'rate_sent') {
      // Brand must have engaged at some point (no point chasing a deal where
      // the brand never replied to our rate — that's pure cold pitch territory).
      return !!d.latest_brand_at;
    }
    return false;
  })
  .sort((a, b) => {
    // Three-tier sort by money on the table:
    //   1. Brand sent a counter $ → sort by their offer DESC (biggest first)
    //   2. We have a pitched rate (real or inferred) → sort by our rate DESC
    //   3. TBD (no $ on either side) → sort by latest brand reply recency
    const aTier = a.brand_counter_cents ? 1 : (a.our_quote_cents ? 2 : 3);
    const bTier = b.brand_counter_cents ? 1 : (b.our_quote_cents ? 2 : 3);
    if (aTier !== bTier) return aTier - bTier;
    if (aTier === 1) return (b.brand_counter_cents || 0) - (a.brand_counter_cents || 0);
    if (aTier === 2) return (b.our_quote_cents || 0) - (a.our_quote_cents || 0);
    return (b.latest_brand_at || b.last_activity_at || '').localeCompare(a.latest_brand_at || a.last_activity_at || '');
  });
  // Add fit score to each — Riley needs to know at-a-glance "is this worth pushing"
  for (const d of enriched) {
    try {
      const fit = computeFitScore({ deal: d, db: P.db() });
      d.fit_score = fit.score;
      d.fit_verdict = fit.verdict;
      d.fit_reasons = fit.reasons;
    } catch {}
  }
  json(res, enriched);
});

// ---- Inbox: brand messages that need a reply ------------------------------
// Returns the latest brand-side messages where ball_in_court is on us, across
// email + WhatsApp threads tied to deals. Sorted oldest-first (oldest is most
// at-risk of going cold). Each row has a deal context block so the Inbox tab
// can show what's pending and we can fire an AI "first reply" suggestion.
route('GET', '/api/inbox', async (req, res, { url }) => {
  const creator = url.searchParams.get('creator') || null;
  // Accept both 'needs-reply' (hyphen) and 'needs_reply' (underscore) for safety
  let filter = (url.searchParams.get('filter') || 'needs-reply').replace(/_/g, '-');
  if (!['needs-reply','waiting','stale','all'].includes(filter)) filter = 'needs-reply';
  const dealFilter = creator ? 'AND d.creator_id = ?' : '';
  const params = creator ? [creator] : [];
  // Ball-in-court filter:
  //   needs-reply = ball on us AND brand sent the most-recent message
  //   waiting     = ball on them, brand active in last 3d
  //   stale       = ball on them, brand silent > 3d
  let ballClause = '';
  if (filter === 'needs-reply')      ballClause = `AND t.ball_in_court = 'us' AND t.last_message_by != 'us'`;
  else if (filter === 'waiting')     ballClause = `AND t.ball_in_court = 'them' AND datetime(t.last_message_at) >= datetime('now', '-3 days')`;
  else if (filter === 'stale')       ballClause = `AND t.ball_in_court = 'them' AND datetime(t.last_message_at) <  datetime('now', '-3 days')`;
  // 'all' → no extra clause

  // For "needs-reply" we want the latest BRAND message; for "waiting/stale/all"
  // we may want the latest message overall (which could be from us — useful to
  // see what we last sent before going quiet).
  const wantBrandOnly = filter === 'needs-reply';
  const msgFilter = wantBrandOnly ? 'AND m.from_us = 0' : '';

  // DEDUPE: one row per deal. Window function picks the most-recently-active
  // thread per deal so the "Velo has 2 threads → shows twice" bug is gone.
  const rows = P.db().prepare(`
    WITH ranked AS (
      SELECT t.*,
             ROW_NUMBER() OVER (PARTITION BY t.deal_id
                                ORDER BY t.last_message_at DESC, t.id DESC) AS rn
      FROM threads t
      WHERE t.deal_id IS NOT NULL
        ${ballClause}
    )
    SELECT t.id AS thread_id, t.channel, t.subject, t.deal_id, t.ball_in_court,
           t.last_message_at, t.last_message_by,
           d.brand, d.creator_id, d.fee_cents, d.funnel_stage, d.raw_stage,
           d.ai_summary, d.next_action,
           (SELECT m.id             FROM messages m WHERE m.thread_id=t.id ${msgFilter} ORDER BY m.sent_at DESC LIMIT 1) AS msg_id,
           (SELECT m.sender         FROM messages m WHERE m.thread_id=t.id ${msgFilter} ORDER BY m.sent_at DESC LIMIT 1) AS sender,
           (SELECT m.from_us        FROM messages m WHERE m.thread_id=t.id ${msgFilter} ORDER BY m.sent_at DESC LIMIT 1) AS msg_from_us,
           (SELECT m.body           FROM messages m WHERE m.thread_id=t.id ${msgFilter} ORDER BY m.sent_at DESC LIMIT 1) AS body,
           (SELECT m.snippet        FROM messages m WHERE m.thread_id=t.id ${msgFilter} ORDER BY m.sent_at DESC LIMIT 1) AS snippet,
           (SELECT m.sent_at        FROM messages m WHERE m.thread_id=t.id ${msgFilter} ORDER BY m.sent_at DESC LIMIT 1) AS sent_at,
           (SELECT m.classification FROM messages m WHERE m.thread_id=t.id ${msgFilter} ORDER BY m.sent_at DESC LIMIT 1) AS classification
    FROM ranked t
    JOIN deals d ON d.id = t.deal_id
    WHERE t.rn = 1
      AND d.state IN ('open','won')
      AND d.funnel_stage != 'completed'  -- wrapped deals belong in Completed tab
      ${dealFilter}
    -- Oldest first: aging-debt order so Riley tackles the stalest replies
    -- first (the brand who waited longest is highest priority).
    ORDER BY sent_at ASC NULLS LAST
    LIMIT 80`).all(...params);
  // Self-heal: any email threads with empty bodies → trigger a fresh pull
  // before serving. This fixes the "blank inbox card" symptom where the bulk
  // sync only stored headers.
  const emptyEmailThreads = rows.filter(r => r.channel === 'email' && r.msg_id && (!r.body || r.body.length < 5));
  if (emptyEmailThreads.length) {
    await Promise.all(emptyEmailThreads.slice(0, 5).map(async (r) => {
      try { await pullSingleThread(P.db(), r.thread_id); } catch {}
    }));
    // Re-fetch the rows we just refreshed
    const refreshed = P.db().prepare(`
      SELECT m.id AS msg_id, m.sender, m.body, m.snippet, m.thread_id
      FROM messages m WHERE m.thread_id IN (${emptyEmailThreads.map(()=>'?').join(',')})
        AND m.from_us = 0
        ORDER BY m.sent_at DESC`).all(...emptyEmailThreads.map(t => t.thread_id));
    const byThread = {};
    for (const r of refreshed) if (!byThread[r.thread_id]) byThread[r.thread_id] = r;
    for (const row of rows) {
      if (byThread[row.thread_id]) {
        row.body = byThread[row.thread_id].body;
        row.snippet = byThread[row.thread_id].snippet;
      }
    }
  }
  // Skip rows where there's no inbound message, strip quoted reply chain
  // Also suppress messages where the AI classifier flagged requires_response=false
  // (e.g. "thanks!", "sent payment via Lumanu") on the needs-reply filter only.
  const inbox = rows.filter(r => {
    if (!r.msg_id || !r.sent_at) return false;
    if (filter === 'needs-reply' && r.classification) {
      try {
        const cls = JSON.parse(r.classification);
        if (cls.requires_response === false) return false;
      } catch {}
    }
    return true;
  }).map(r => {
    let body = r.body;
    if (r.channel === 'email' && body) body = stripQuotedReply(body);
    if (!body || body.length < 5) body = r.snippet || body;
    return {
      thread_id: r.thread_id,
      channel: r.channel,
      deal_id: r.deal_id,
      brand: r.brand,
      creator_id: r.creator_id,
      funnel_stage: r.funnel_stage,
      raw_stage: r.raw_stage,
      fee_cents: r.fee_cents,
      ai_summary: r.ai_summary,
      next_action: r.next_action,
      ball_in_court: r.ball_in_court,
      msg_id: r.msg_id,
      sender: r.sender,
      msg_from_us: !!r.msg_from_us,
      body,
      snippet: r.snippet,
      sent_at: r.sent_at,
      age_hours: r.sent_at ? Math.round((Date.now() - new Date(r.sent_at).getTime()) / 3600000) : null,
    };
  });

  // DEDUPE with Today: brands already on Today (Confirmed or Close These Deals)
  // act on their reply via the unread chip + Cook button on the deal pill.
  // Inbox = brands NOT on Today (orphan threads, pre-deal conversations) so
  // each brand has one canonical action location. When Inbox is "empty," the
  // headline tells Riley how many reply-needed brands sit on Today instead.
  if (filter === 'needs-reply' && creator) {
    try {
      const twRes = await fetch(`http://localhost:${PORT}/api/this-week?creator=${encodeURIComponent(creator)}`);
      const tw = await twRes.json();
      const onToday = new Set([
        ...(tw.deals || []).map(d => d.deal_id),
        ...(tw.pending || []).map(d => d.deal_id),
      ]);
      // Count how many of the inbox items WOULD have been here but are dedupe'd to Today
      const onTodayCount = inbox.filter(r => onToday.has(r.deal_id)).length;
      const filtered = inbox.filter(r => !onToday.has(r.deal_id));
      // Echo onTodayCount in a small meta so the UI can show "+ 3 reply-needed on Today"
      return json(res, { items: filtered, on_today_count: onTodayCount });
    } catch {
      // If dedupe fetch fails, return full inbox (legacy shape)
    }
  }
  json(res, inbox);
});

// Quick-reply path for Inbox/pill — takes a user-edited body and sends it as
// a threaded Gmail reply WITHOUT needing a pre-cooked draft row. Used when
// Riley cooks + edits + sends in one shot.
route('POST', '/api/deals/([^/]+)/draft-and-send', async (req, res, { match }) => {
  const dealId = match[1];
  const deal = P.data.getDeal(dealId);
  if (!deal) return json(res, { ok:false, reason:'deal not found' }, 404);
  if (!hasGmailToken()) return json(res, { ok:false, reason:'Gmail not connected' });
  const body = JSON.parse((await readBody(req)) || '{}');
  if (!body.body) return json(res, { ok:false, reason:'body required' }, 400);

  // Find the latest brand thread for this deal (skip Google Doc / noreply senders)
  const thread = P.db().prepare(`SELECT id, last_message_at FROM threads
    WHERE deal_id=? AND channel='email' ORDER BY last_message_at DESC LIMIT 1`).get(dealId);
  if (!thread) return json(res, { ok:false, reason:'no email thread found' });
  // Latest inbound message (to reply to)
  const last = P.db().prepare(`SELECT id, sender FROM messages
    WHERE thread_id=? AND from_us=0 ORDER BY sent_at DESC LIMIT 1`).get(thread.id);
  if (!last) return json(res, { ok:false, reason:'no inbound message to reply to' });

  try {
    const sendRes = await sendThreadedReply({
      thread_id: thread.id,
      reply_to_msg_id: last.id,
      to: deal.contact_email,
      subject: null,  // sendThreadedReply pulls subject from the original message
      body: body.body,
    });
    P.data.log({ who:'riley', action:'quick_reply_sent', deal_id: dealId,
      summary: `→ ${sendRes.to || deal.contact_email}`, meta: { gmail_message_id: sendRes.id }});
    // Flip ball back to brand
    P.db().prepare(`UPDATE deals SET ball_in_court='them', last_activity_at=datetime('now'),
      last_activity_by='us' WHERE id=?`).run(dealId);
    P.db().prepare(`UPDATE threads SET ball_in_court='them', last_message_at=datetime('now'),
      last_message_by='us' WHERE id=?`).run(thread.id);
    // Backfill the just-sent message so the conversation view shows it
    // immediately — otherwise Riley has to wait for the next Gmail sync.
    try { await pullSingleThread(P.db(), thread.id); } catch {}
    // Same post-send freshness pass as the draft-approve path: invalidate the
    // AI summary cache + queue a lifecycle audit so the deal pill re-renders
    // with the new state on next view.
    try {
      P.db().prepare(`UPDATE deals SET ai_summary_for = NULL WHERE id = ?`).run(dealId);
      const apiKey = process.env.OPENAI_API_KEY;
      if (apiKey && P.cfg('ai_enabled','false') === 'true') {
        const { queueAudit } = await import('./engines/lifecycle_audit.js');
        const dealRow = P.db().prepare(`SELECT * FROM deals WHERE id = ?`).get(dealId);
        if (dealRow) queueAudit({ db: P.db(), deal: dealRow, apiKey, spend: P.spend });
      }
    } catch {}
    json(res, { ok:true, sent:true, ...sendRes });
  } catch (e) {
    json(res, { ok:false, reason: e.message }, 500);
  }
});

// AI first-reply cook for an Inbox row — drafts a context-aware response that
// uses the rate card + playbook (zero exclusivity, ask recurring, etc.).
// Body param `mode`: 'reply' (default) | 'nudge' (follow-up when brand quiet)
route('POST', '/api/inbox/([^/]+)/cook', async (req, res, { match }) => {
  // URL-decode so WhatsApp thread ids like "wa:Nawa Sparkone Media" resolve
  const thread_id = decodeURIComponent(match[1]);
  const bodyIn = JSON.parse((await readBody(req)) || '{}');
  const mode = bodyIn.mode === 'nudge' ? 'nudge' : 'reply';
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || P.cfg('ai_enabled','false') !== 'true')
    return json(res, { ok:false, reason:'AI not enabled' }, 400);
  // Pull thread + deal + recent messages
  const t = P.db().prepare(`SELECT t.*, d.id AS d_id, d.brand, d.creator_id, d.fee_cents,
    d.funnel_stage, d.raw_stage, d.ai_summary, d.next_action,
    d.posting_date, d.exclusivity_days, d.usage_rights, d.primary_channel
    FROM threads t LEFT JOIN deals d ON d.id=t.deal_id WHERE t.id=?`).get(thread_id);
  if (!t) return json(res, { ok:false, reason:'thread not found' }, 404);
  const msgs = P.db().prepare(`SELECT sender, from_us, sent_at, body, snippet
    FROM messages WHERE thread_id=? ORDER BY sent_at DESC LIMIT 8`).all(thread_id).reverse();
  const lastBrand = [...msgs].reverse().find(m => !m.from_us);

  const creator = t.creator_id || null;
  const card = creator && RATE_CARD[creator] ? RATE_CARD[creator] : null;
  const cap = creator ? creator[0].toUpperCase() + creator.slice(1) : 'creator';
  const channelTone = t.channel === 'whatsapp'
    ? 'TONE: WhatsApp — casual, short, lowercase ok, no signoff, no emojis.'
    : 'TONE: Email — direct, warm, 2–4 sentences, no fluff. Signoff: "Riley". Use brand contact name in greeting if known.';

  // Build rate guidance from the card
  let rateBlock = '';
  if (card) {
    const lines = [];
    if (card.ig_reel_cents)  lines.push(`IG Reel: $${(card.ig_reel_cents/100).toLocaleString()}`);
    if (card.tiktok_cents)   lines.push(`TikTok: $${(card.tiktok_cents/100).toLocaleString()}`);
    if (card.ig_story_cents) lines.push(`IG Story: $${(card.ig_story_cents/100).toLocaleString()}`);
    if (card.ugc_cents)      lines.push(`UGC: $${(card.ugc_cents/100).toLocaleString()}`);
    if (card.floor_cents)    lines.push(`(Floor: $${(card.floor_cents/100).toLocaleString()} — never go below)`);
    rateBlock = `${cap}'S RATE CARD:\n${lines.join('\n')}`;
  }
  const policy = `
PLAYBOOK (apply silently):
- EXCLUSIVITY: push for ZERO. Accept up to 30 days same-category only if brand insists. Redline anything 90+.
- RECURRING: at the START of a new conversation, propose a recurring 3–6 month structure as a counter to one-off ("worth running one as a test first?"). If brand declines → fine, run the one-off test.
- PAYMENT: net 30 from invoice is default. Accept net 60 with redline flag. Redline net 90+.
- USAGE: prefer 30-day organic + paid amplification ≤ 90 days. Anything perpetual = redline.`;

  const dealCtx = t.d_id ? `
DEAL: ${t.brand} (${creator})
STAGE: ${t.funnel_stage} / ${t.raw_stage}
FEE LOCKED: ${t.fee_cents ? '$' + (t.fee_cents/100).toLocaleString() : 'not yet'}
NEXT ACTION: ${t.next_action || t.ai_summary || '(unspecified)'}` : '(no linked deal yet — this is a new inbound)';

  const taskLine = mode === 'nudge'
    ? `Write a SHORT, polite NUDGE — the brand has gone quiet and we want a status update. Don't apologize. Don't repeat your prior pitch in full. Just check in: "circling back, any update on X?" or "wanted to flag we're holding the slot until Y date."`
    : `Write a SHORT first reply to the brand's last message.`;

  const sys = `You are Riley, an influencer manager. ${taskLine}
${channelTone}
${policy}

Rules:
- If brand is pitching a project, ALWAYS share ${cap}'s rate (use card below). Don't dance around price.
- If brand is asking timeline/process — keep it tight, give them what they need.
- If brand mentions exclusivity, even subtly, counter-propose ZERO and offer 30 days max as fallback.
- If this is a brand-new pitch and we haven't talked recurring yet, plant the seed: "we'd love to explore something recurring if there's appetite — start with one as a test?"
- Never accept a fee below ${cap}'s floor.
- Don't ramble. 2–4 sentences for email, 1–3 for WhatsApp.`;

  const user = `${dealCtx}

${rateBlock}

THREAD (oldest → newest, last ${msgs.length}):
${msgs.map(m => `${m.from_us ? 'Riley' : (m.sender||'brand').split('<')[0].trim().slice(0,30)} (${(m.sent_at||'').slice(0,16)}): ${(m.body || m.snippet || '').replace(/\s+/g,' ').slice(0,500)}`).join('\n')}

${lastBrand ? `Brand's last message to reply to:\n"${(lastBrand.body || lastBrand.snippet || '').slice(0, 800)}"` : '(no recent brand message — give a polite first reply)'}

Write Riley's reply now.`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST', headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body: JSON.stringify({ model:'gpt-4o', temperature:0.4, max_tokens:400,
        messages:[{role:'system',content:sys},{role:'user',content:user}]}),
    });
    const data = await r.json();
    const body = data.choices?.[0]?.message?.content?.trim() || '';
    const cost = Math.round((data.usage?.prompt_tokens||0) * 0.00025)
               + Math.round((data.usage?.completion_tokens||0) * 0.001);
    P.spend.record({ provider:'openai', model:'gpt-4o', operation:'inbox_first_reply',
      prompt_tokens: data.usage?.prompt_tokens || 0, completion_tokens: data.usage?.completion_tokens || 0,
      est_cost_cents: cost });
    json(res, { ok:true, body, channel: t.channel });
  } catch (e) {
    json(res, { ok:false, reason: e.message }, 500);
  }
});

// Inbox Pitches — unmatched brand emails that look like new deal pitches.
// Returns threads where:
//   - No deal_id linked
//   - Subject contains pitch keywords OR last brand reply mentions partnership/$
//   - Not dismissed by Riley
//   - Last activity in last 30 days
// For each, includes AI-classified creator guess (cooper/charlie) + brand name.
route('GET', '/api/inbox-pitches', async (req, res, { url }) => {
  const force = url.searchParams.get('force') === '1';
  // SQLite doesn't ship REGEXP — use a bunch of LIKE OR's instead.
  const candidates = P.db().prepare(`
      SELECT t.id AS thread_id, t.subject, t.last_message_at, t.last_message_by,
             t.pitch_creator, t.pitch_category, t.pitch_classified_at,
             (SELECT m.sender FROM messages m WHERE m.thread_id=t.id AND m.from_us=0 ORDER BY m.sent_at DESC LIMIT 1) AS sender,
             (SELECT m.body    FROM messages m WHERE m.thread_id=t.id AND m.from_us=0 ORDER BY m.sent_at DESC LIMIT 1) AS body,
             (SELECT m.snippet FROM messages m WHERE m.thread_id=t.id AND m.from_us=0 ORDER BY m.sent_at DESC LIMIT 1) AS snippet,
             (SELECT m.sent_at FROM messages m WHERE m.thread_id=t.id AND m.from_us=0 ORDER BY m.sent_at DESC LIMIT 1) AS brand_sent_at,
             (SELECT COUNT(*)  FROM messages m WHERE m.thread_id=t.id) AS msg_count
      FROM threads t
      WHERE t.deal_id IS NULL
        AND t.channel = 'email'
        AND t.pitch_dismissed_at IS NULL
        AND datetime(t.last_message_at) >= datetime('now', '-30 days')
        AND (
          LOWER(t.subject) LIKE '%collab%' OR
          LOWER(t.subject) LIKE '%partnership%' OR
          LOWER(t.subject) LIKE '%paid%' OR
          LOWER(t.subject) LIKE '%sponsor%' OR
          LOWER(t.subject) LIKE '%campaign%' OR
          LOWER(t.subject) LIKE '%opportunity%' OR
          LOWER(t.subject) LIKE '%ugc%' OR
          LOWER(t.subject) LIKE '%influencer%' OR
          LOWER(t.subject) LIKE '%creator%' OR
          LOWER(t.subject) LIKE '%brand deal%'
        )
      ORDER BY t.last_message_at DESC LIMIT 30
    `).all();

  // Filter out automated senders + non-brand-deal domains.
  // (1) Workflow/infra: DocuSign, PandaDoc, e-sign, calendar, project mgmt
  // (2) E-commerce / personal services: Etsy, Shopify, Stripe, Square, Amazon
  // (3) Social network notifications: LinkedIn, Twitter, Instagram emails
  // (4) Newsletter platforms: Substack, Beehiiv, ConvertKit (unless Riley actually replied to them)
  // (5) Calendar / scheduling: Calendly, Cal.com
  const skipDomains = /(docusign|pandadoc|signnow|hellosign|adobesign|noreply|notification|via-google|mailer-daemon|@apollo\.io|@gmass|@convertkit|@mailchimp|@calendly|@cal\.com|@notion\.so|@etsy\.com|@stripe\.com|@shopify\.com|@square\.com|@amazon\.com|@linkedin\.com|@twitter\.com|@x\.com|@meta\.com|@instagram\.com|@facebookmail\.com|@substack\.com|@beehiiv\.com|@medium\.com|@spotify\.com|@youtube\.com|@google\.com|@accounts\.google|@dropbox\.com|@zoom\.us|@github\.com)/i;
  let filtered = candidates.filter(r => !skipDomains.test(r.sender || ''));

  // ---- ENGINE FIX 1: auto-dismiss empty pitches ---------------------------
  // If body AND sender are both empty, the thread is a template ghost (failed
  // ingest, bounce, etc.). Mark it dismissed so it never reappears.
  const emptyDismissed = [];
  filtered = filtered.filter(r => {
    const bodyClean = (r.body || r.snippet || '').replace(/\s+/g,'').trim();
    const senderClean = (r.sender || '').trim();
    if (!bodyClean && !senderClean) {
      P.db().prepare(`UPDATE threads SET pitch_dismissed_at=datetime('now') WHERE id=?`).run(r.thread_id);
      emptyDismissed.push(r.thread_id);
      return false;
    }
    return true;
  });

  // ---- ENGINE FIX 1.5: pull full Gmail thread + auto-promote active conversations
  // Riley's prior replies might live in Gmail but not in our DB yet (older
  // than the last sync window). Fetch the full thread first, then any thread
  // where Riley already replied = ongoing negotiation → AUTO-CREATE A DEAL
  // (don't just dismiss it as "no longer a pitch" — that orphans the convo).
  //
  // IMPORTANT: subject-match against existing brands runs FIRST (below in
  // FIX 2) so we never auto-create a new deal when the subject clearly maps
  // to an existing one (e.g. "Re: Velo onboarding x @cooper" → link to Velo,
  // don't create "Valentine Fourmentin [review brand]").
  if (hasGmailToken() && filtered.length) {
    await Promise.all(filtered.slice(0, 15).map(async (r) => {
      try { await pullSingleThread(P.db(), r.thread_id); } catch {}
    }));
    // FIRST: match against existing brands by subject. If hit, link + skip.
    const allDealsForLink = P.db().prepare(`SELECT id, brand FROM deals WHERE state != 'lost' AND brand IS NOT NULL`).all();
    const brandIndex = allDealsForLink.map(d => ({
      id: d.id,
      norm: (d.brand || '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(),
    })).filter(x => x.norm.length >= 5);
    filtered = filtered.filter(r => {
      const subjNorm = (r.subject || '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
      if (!subjNorm) return true;
      let match = null;
      for (const d of brandIndex) {
        const pattern = new RegExp(`\\b${d.norm.replace(/\s+/g,'\\s+')}\\b`, 'i');
        if (pattern.test(subjNorm) && (!match || d.norm.length > match.norm.length)) match = d;
      }
      if (match) {
        P.db().prepare(`UPDATE threads SET deal_id=?, pitch_dismissed_at=NULL WHERE id=?`).run(match.id, r.thread_id);
        return false;
      }
      return true;
    });
    // SECOND: any thread Riley already replied to but we couldn't subject-link
    // → auto-create a deal.
    const ongoingIds = filtered.length ? P.db().prepare(`
      SELECT thread_id FROM messages
      WHERE thread_id IN (${filtered.map(()=>'?').join(',')})
        AND from_us = 1
      GROUP BY thread_id`).all(...filtered.map(r => r.thread_id)).map(x => x.thread_id) : [];
    if (ongoingIds.length) {
      const ongoingSet = new Set(ongoingIds);
      const promotedAuto = [];
      filtered = filtered.filter(r => {
        if (!ongoingSet.has(r.thread_id)) return true;
        // Active back-and-forth → auto-create a deal so this conversation
        // doesn't fall into a black hole.
        // Brand-name heuristic: agency/manager domains often hide the real
        // brand. Try subject first (often contains "X x @creator" or "X paid
        // collab"), then fall back to sender domain root (e.g. shein.com → SHEIN).
        const senderEmail = (r.sender || '').match(/<([^>]+)>/)?.[1] || (r.sender || '');
        const senderDomain = senderEmail.split('@')[1] || '';
        const senderName = (r.sender || '').match(/^["']?([^<"']+?)["']?\s*</)?.[1]?.trim() || senderEmail.split('@')[0];
        // Agency / talent-manager domains where sender name = manager, not brand
        const AGENCY_DOMAINS = /(mediacube|hireinfluence|fancy|scrollstop|sparkone|inpander|agentone|talenthouse|tribe|whalar|aspire|impact|modash|grin|levanta|creator\.co)/i;
        const isAgency = AGENCY_DOMAINS.test(senderDomain);
        let brand;
        if (isAgency) {
          // Try to extract brand from subject line: "X Paid Collab", "X campaign", "X x @creator", etc.
          const subjMatch = (r.subject || '')
            .replace(/^(Re:|Fwd?:|RE:|FW:)\s*/i, '')
            .match(/^([\w&.\- ]+?)(?=\s+[xX×]\s+|\s+paid|\s+brand|\s+campaign|\s+collab|\s+sponsor|\s+partnership)/i);
          brand = subjMatch?.[1]?.trim();
          // Fall back to "[Agency] — review brand" so Riley knows to rename it
          if (!brand) brand = `${senderName} [review brand]`;
        } else {
          // Use domain root as brand (e.g. shein.com → SHEIN, helinox.com → Helinox)
          const domainRoot = (senderDomain.split('.')[0] || senderName).replace(/[-_]/g, ' ');
          brand = domainRoot.charAt(0).toUpperCase() + domainRoot.slice(1);
        }
        brand = brand.slice(0, 80);
        const slug = brand.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);
        const creator = r.pitch_creator && ['cooper','charlie'].includes(r.pitch_creator) ? r.pitch_creator : 'cooper';
        const dealId = `${slug}-${creator}`;
        try {
          const exists = P.db().prepare(`SELECT id FROM deals WHERE id=?`).get(dealId);
          if (!exists) {
            P.db().prepare(`INSERT INTO deals (id, brand, brand_key, creator_id, funnel_stage, state,
              raw_stage, priority, ball_in_court, primary_channel, last_activity_at,
              last_activity_by, next_action, next_action_detail, thread_id, category)
              VALUES (?, ?, ?, ?, 'conversation', 'open', 'awaiting_brand', 'medium', 'us', 'email',
                ?, 'them', 'Reply to active conversation',
                'Auto-created from ongoing Gmail thread — Riley already replied. Review and finalize stage.',
                ?, ?)`)
              .run(dealId, brand, brand, creator, r.last_message_at || new Date().toISOString(),
                   r.thread_id, r.pitch_category || null);
            promotedAuto.push({ deal: dealId, thread: r.thread_id });
          }
          // Link the thread to the deal regardless
          P.db().prepare(`UPDATE threads SET deal_id=?, pitch_dismissed_at=NULL WHERE id=?`).run(dealId, r.thread_id);
        } catch (e) {
          // Fallback: dismiss so it doesn't keep appearing as a pitch
          P.db().prepare(`UPDATE threads SET pitch_dismissed_at=datetime('now') WHERE id=?`).run(r.thread_id);
        }
        return false; // drop from pitches list
      });
    }
  }

  // ---- ENGINE FIX 2: auto-link thread continuations to existing deals -----
  // If the subject explicitly mentions an existing deal's brand (e.g. "Re:
  // ZenBusiness Velo AI Campaign x @cooper.simson"), the email isn't a new
  // pitch — it's a continuation. Link the thread to that deal so it shows up
  // in the deal's conversation view instead of cluttering "New pitches".
  const allDeals = P.db().prepare(`SELECT id, brand FROM deals WHERE state != 'lost' AND brand IS NOT NULL`).all();
  const dealBrandIndex = allDeals.map(d => ({
    id: d.id,
    // Normalize: lowercase, strip non-alphanumeric → distinctive token
    norm: (d.brand || '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(),
  })).filter(x => x.norm.length >= 5); // skip 1-2 letter brands to avoid false hits
  const linkedToExisting = [];
  filtered = filtered.filter(r => {
    const subjNorm = (r.subject || '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
    if (!subjNorm) return true;
    // Find the longest brand token contained in the subject (longest = most distinctive)
    let match = null;
    for (const d of dealBrandIndex) {
      // Tokens must be word-bounded: "velo" in "develop" shouldn't match.
      // Build a regex: \b<norm>\b but treat spaces in norm as flexible.
      const pattern = new RegExp(`\\b${d.norm.replace(/\s+/g,'\\s+')}\\b`, 'i');
      if (pattern.test(subjNorm) && (!match || d.norm.length > match.norm.length)) {
        match = d;
      }
    }
    if (match) {
      P.db().prepare(`UPDATE threads SET deal_id=? WHERE id=?`).run(match.id, r.thread_id);
      linkedToExisting.push({ thread: r.thread_id, deal: match.id });
      return false;
    }
    return true;
  });

  // AI-classify any pitches that don't yet have a creator guess
  const apiKey = process.env.OPENAI_API_KEY;
  const aiOn = !!apiKey && P.cfg('ai_enabled','false') === 'true';
  const unclassified = filtered.filter(r => force || !r.pitch_creator);
  if (aiOn && unclassified.length) {
    await Promise.all(unclassified.slice(0, 15).map(async (r) => {
      try {
        const result = await classifyPitch({
          subject: r.subject, sender: r.sender,
          body: (r.body || r.snippet || '').slice(0, 1200),
          apiKey,
        });
        if (result?.creator) {
          P.db().prepare(`UPDATE threads SET pitch_creator=?, pitch_category=?, pitch_classified_at=datetime('now') WHERE id=?`)
            .run(result.creator, result.category || null, r.thread_id);
          r.pitch_creator = result.creator;
          r.pitch_category = result.category;
        }
      } catch (e) { /* keep silent — bad classification is fine */ }
    }));
  }

  // ---- ENGINE FIX 3: auto-dismiss off-creator pitches ---------------------
  // If AI confidently classified a pitch as belonging to a creator Riley
  // doesn't manage (Beth, Amie, etc.), dismiss it so it never reappears.
  // Cooper + Charlie + unknown still flow through normally.
  const MANAGED = new Set(['cooper','charlie','unknown']);
  filtered = filtered.filter(r => {
    if (r.pitch_creator && !MANAGED.has(r.pitch_creator)) {
      P.db().prepare(`UPDATE threads SET pitch_dismissed_at=datetime('now') WHERE id=?`).run(r.thread_id);
      return false;
    }
    return true;
  });

  // Strip quoted reply chains from bodies for display
  json(res, filtered.map(r => {
    let bodyClean = r.body || r.snippet || '';
    if (bodyClean) { try { bodyClean = stripQuotedReply(bodyClean) || bodyClean; } catch {} }
    bodyClean = bodyClean.slice(0, 600);
    // Brand name from sender
    const rawSender = r.sender || '';
    const brandMatch = rawSender.match(/^["']?([^<"']+?)["']?\s*<.+>/) || [null, rawSender.split('@')[0]];
    const brand = (brandMatch[1] || rawSender).trim();
    return {
      thread_id: r.thread_id,
      subject: r.subject,
      sender: rawSender,
      brand,
      body: bodyClean,
      brand_sent_at: r.brand_sent_at,
      msg_count: r.msg_count,
      age_hours: r.brand_sent_at ? Math.round((Date.now() - new Date(r.brand_sent_at).getTime()) / 3600000) : null,
      creator_guess: r.pitch_creator || null,
      category_guess: r.pitch_category || null,
    };
  }));
});

// AI helper — classify a single pitch into creator + category
async function classifyPitch({ subject, sender, body, apiKey }) {
  const sys = `You read a brand email pitch and return JSON with which creator it's for.

Roster:
- COOPER SIMSON — 78K IG, niche: AI / SaaS / tools / B2B creator tech (Sintra, MiniMax, Higgsfield, GoMarble all sponsor him).
- CHARLIE STRINGER — 306K IG + 233K TT, niche: outdoor / lifestyle / gear (Helinox, HOVERAir, Mirage, Wulcea sponsor him).
- BETH — fitness/wellness (separate creator, NOT managed by this platform).
- AMIE — fitness/dance.

CLASSIFY BASED ON:
- Brand category (AI tools → cooper, outdoor → charlie, fitness → beth/amie).
- Subject/body mentions of @cooper, @charlie, etc.
- Match the brand's niche to a creator's audience.

OUTPUT (JSON only):
{"creator": "cooper"|"charlie"|"beth"|"amie"|"unknown", "category": "ai_saas"|"outdoor"|"fitness"|"hydration"|"apparel"|"unknown", "confidence": "high"|"medium"|"low"}

Be conservative — if you can't tell, return creator="unknown".`;
  const user = `Subject: ${subject || '(no subject)'}
Sender: ${sender || 'unknown'}
Body excerpt:
${body || '(no body)'}`;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method:'POST', headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
    body: JSON.stringify({
      model: 'gpt-4o-mini', temperature: 0.2, max_tokens: 100,
      response_format: { type: 'json_object' },
      messages: [{role:'system',content:sys},{role:'user',content:user}],
    }),
  });
  if (!r.ok) return null;
  const data = await r.json();
  try { return JSON.parse(data.choices?.[0]?.message?.content || '{}'); } catch { return null; }
}

// Dismiss an inbox pitch — marks the thread so it stops appearing
route('POST', '/api/inbox-pitches/([^/]+)/dismiss', async (req, res, { match }) => {
  const tid = decodeURIComponent(match[1]);
  P.db().prepare(`UPDATE threads SET pitch_dismissed_at=datetime('now') WHERE id=?`).run(tid);
  json(res, { ok:true });
});

// Promote an inbox pitch → creates a deal in 'conversation' stage + links the thread
route('POST', '/api/inbox-pitches/([^/]+)/promote', async (req, res, { match }) => {
  const tid = decodeURIComponent(match[1]);
  const body = JSON.parse((await readBody(req)) || '{}');
  if (!['cooper','charlie'].includes(body.creator_id))
    return json(res, { ok:false, reason:'creator_id required (cooper|charlie)' }, 400);
  if (!body.brand) return json(res, { ok:false, reason:'brand required' }, 400);
  const slug = body.brand.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);
  const dealId = `${slug}-${body.creator_id}`;
  const existing = P.db().prepare(`SELECT id FROM deals WHERE id=?`).get(dealId);
  if (!existing) {
    P.db().prepare(`INSERT INTO deals (id, brand, brand_key, creator_id, funnel_stage, state,
      raw_stage, priority, ball_in_court, primary_channel, last_activity_at, last_activity_by, next_action,
      thread_id, category)
      VALUES (?, ?, ?, ?, 'conversation', 'open', 'awaiting_brand', 'medium', 'us', 'email',
        datetime('now'), 'them', 'Brand pitched — decide direction', ?, ?)`)
      .run(dealId, body.brand, body.brand, body.creator_id, tid, body.category || null);
  }
  // Link the thread to the new deal
  P.db().prepare(`UPDATE threads SET deal_id=? WHERE id=?`).run(dealId, tid);
  P.data.log({ who:'riley', action:'pitch_promoted', deal_id: dealId, summary:`from thread ${tid}` });
  // Banner notification
  P.db().prepare(`INSERT INTO notifications (kind, deal_id, title, body) VALUES (?, ?, ?, ?)`)
    .run('lead_promoted', dealId, `📨 New deal: ${body.brand}`, `Created from inbox pitch — assigned to ${body.creator_id}.`);
  json(res, { ok:true, deal_id: dealId });
});

// ---- New Leads (unmatched contracts / e-sign envelopes with real $) --------
// Surfaces inbound briefs/contracts that haven't been linked to a deal yet,
// but only when there's a clear signal a real deal is brewing (fee >= $300).
// Renders as a small tray under Active Deals so leads never slip.
route('GET', '/api/leads', async (req, res, { url }) => {
  const creator = url.searchParams.get('creator') || null;
  // Orphan contracts: no deal_id, fee >= $300 from AI extraction, not dismissed,
  // last 14 days. brand pulled from AI-extracted `brand_party` in the JSON.
  const rawContracts = P.db().prepare(`SELECT * FROM contracts
    WHERE deal_id IS NULL AND dismissed_at IS NULL
      AND fee_cents IS NOT NULL AND fee_cents >= 30000
      AND datetime(created_at) >= datetime('now', '-14 days')
    ORDER BY created_at DESC LIMIT 30`).all();
  // Build a normalized brand index for de-orphaning leads whose brand_party
  // fuzzy-matches an existing deal (catches "PlayOS, Inc." → Sintra.ai).
  const allDeals = P.data.listDeals({ limit: 2000 });
  const norm = s => (s || '').toLowerCase()
    .replace(/\.(ai|com|io|co|app|inc)\b/g,'')
    .replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  const dealBrandWords = allDeals.flatMap(d => {
    const n = norm(d.brand);
    return n ? [{ n, id: d.id }, ...n.split(' ').filter(w => w.length > 3).map(w => ({ n: w, id: d.id }))] : [];
  });
  const matchesExistingDeal = (brand) => {
    const needle = norm(brand);
    if (!needle) return false;
    return dealBrandWords.some(({ n }) => needle.includes(n) || n.includes(needle));
  };

  const contractLeads = rawContracts.map(c => {
    let extracted = {};
    try { extracted = JSON.parse(c.extracted || '{}'); } catch {}
    const brand = extracted.brand_party || (c.file_path || '').split('/').pop()?.replace(/^\d+-/, '').replace(/\.[^.]+$/, '');
    return {
      id: c.id,
      kind: 'contract',
      brand,
      fee_cents: c.fee_cents,
      posting_date: extracted.posting_date_iso || extracted.posting_window_start_iso || null,
      usage_rights: c.usage_rights,
      payment_terms: c.payment_terms,
      file_url: c.file_path ? '/' + c.file_path : null,
      file_name: (c.file_path || '').split('/').pop(),
      summary: extracted.summary || null,
      is_brief: !!extracted.is_brief,
      created_at: c.created_at,
      source: 'contract_upload',
      _matched_existing: matchesExistingDeal(brand),
    };
  }).filter(l => !l._matched_existing);
  // Orphan pending e-sign envelopes: kind=esign_pending, deal_id IS NULL, not dismissed
  const rawEsign = P.db().prepare(`SELECT * FROM notifications
    WHERE kind='esign_pending' AND deal_id IS NULL
      AND dismissed_at IS NULL AND undone_at IS NULL
      AND datetime(created_at) >= datetime('now', '-14 days')
    ORDER BY created_at DESC LIMIT 30`).all();
  const esignLeads = rawEsign.map(n => ({
    id: n.id,
    kind: 'esign',
    brand: (n.title || '').replace(/^🖊️\s*/, '').replace(/\s+sent.*/, '').trim() || 'Unknown brand',
    fee_cents: null,
    body: n.body,
    created_at: n.created_at,
    source: 'esign_envelope',
  }));
  // Filter by current creator if specified — but since unmatched leads have no
  // creator yet, we always show them (Riley picks creator on Create-deal).
  const all = [...contractLeads, ...esignLeads]
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  json(res, all);
});

// Clash check for a lead BEFORE creating the deal — surfaces any exclusivity
// blocks, category-spacing warns, or duplicate-brand warns. Riley sees this
// in the expanded lead view so he can decide whether to Create / Dismiss.
route('POST', '/api/leads/(contract|esign)/([^/]+)/clash-check', async (req, res, { match }) => {
  const [, kind, id] = match;
  const body = JSON.parse((await readBody(req)) || '{}');
  const creator = body.creator_id;
  if (!['cooper','charlie'].includes(creator))
    return json(res, { ok:false, reason:'creator_id required' }, 400);

  // Pull category + posting date from the lead's extraction
  let category = null, postingDate = null, brand = body.brand;
  let exclDays = null;
  if (kind === 'contract') {
    const c = P.db().prepare('SELECT * FROM contracts WHERE id=?').get(id);
    if (c) {
      try {
        const ex = JSON.parse(c.extracted || '{}');
        category = ex.category || guessCategoryFromBrand(brand || ex.brand_party);
        postingDate = ex.posting_date_iso || ex.posting_window_start_iso || null;
        exclDays = c.exclusivity_days || null;
        brand = brand || ex.brand_party;
      } catch {}
    }
  } else {
    category = guessCategoryFromBrand(brand);
  }

  // Build a synthetic deal for the clash engine
  const target = {
    id: '__lead__',
    creator_id: creator,
    brand: brand || 'NewLead',
    brand_key: (brand || '').toLowerCase(),
    category,
    posting_date: postingDate,
    posting_window_start: postingDate,
    posting_window_end:   postingDate,
    exclusivity_required: !!exclDays,
    exclusivity_days: exclDays,
    state: 'open',
  };

  const { computeClashes } = await import('./engines/clash.js');
  const allDeals = P.data.listDeals({ creator, limit: 2000 });
  // Also flag brand-already-have-a-deal-with (any state)
  const norm = s => (s || '').toLowerCase().replace(/\.(ai|com|io|co|app|inc)\b/g,'').replace(/[^a-z0-9 ]/g,'').trim();
  const brandKey = norm(brand);
  const sameBrand = allDeals.filter(d => brandKey && (norm(d.brand) === brandKey || norm(d.brand_key) === brandKey));

  const clashes = computeClashes([...allDeals, target]);
  // Only return clashes involving our synthetic target
  const myClashes = clashes.filter(c => c.deal_a === '__lead__' || c.deal_b === '__lead__');
  // Look up the OTHER deal for each clash so the UI can name it
  const enriched = myClashes.map(c => {
    const otherId = c.deal_a === '__lead__' ? c.deal_b : c.deal_a;
    const other = allDeals.find(d => d.id === otherId);
    return { ...c, other_deal: other ? { id: other.id, brand: other.brand, posting_date: other.posting_date, category: other.category } : null };
  });
  json(res, {
    ok: true,
    verdict: enriched.some(c => c.severity === 'block') ? 'blocked'
           : (enriched.length || sameBrand.length) ? 'tight'
           : 'clear',
    blockers: enriched.filter(c => c.severity === 'block'),
    warnings: enriched.filter(c => c.severity === 'warn'),
    same_brand_existing: sameBrand.map(d => ({ id: d.id, brand: d.brand, funnel_stage: d.funnel_stage, state: d.state, fee_cents: d.fee_cents })),
    detected_category: category,
    detected_posting_date: postingDate,
  });
});

function guessCategoryFromBrand(s) {
  if (!s) return null;
  const t = s.toLowerCase();
  if (/\b(ai|gpt|llm|agent|saas|sintra|hailuo|skywork|minimax|invideo|capcut|predis|typeless|higgsfield|playos|fanvue|rocket|napkin)\b/.test(t)) return 'ai_saas';
  if (/\b(creatine|protein|whey|fuel|hydration|liquid|drink)\b/.test(t)) return 'hydration';
  if (/\b(hovera?ir|drone|gopro|gear|outdoor|camp|hike|tent)\b/.test(t)) return 'outdoor';
  return null;
}

// Dismiss an unmatched lead (contract or e-sign notification)
route('POST', '/api/leads/(contract|esign)/([^/]+)/dismiss', async (req, res, { match }) => {
  const [, kind, id] = match;
  if (kind === 'contract') {
    P.db().prepare(`UPDATE contracts SET dismissed_at=datetime('now') WHERE id=?`).run(id);
  } else {
    P.db().prepare(`UPDATE notifications SET dismissed_at=datetime('now') WHERE id=?`).run(Number(id));
  }
  json(res, { ok:true });
});

// Promote a lead → creates a real deal row + links the contract (if applicable)
// Body: { creator_id: 'cooper'|'charlie', brand, fee_cents }
route('POST', '/api/leads/(contract|esign)/([^/]+)/promote', async (req, res, { match }) => {
  const [, kind, id] = match;
  const body = JSON.parse((await readBody(req)) || '{}');
  if (!['cooper','charlie'].includes(body.creator_id))
    return json(res, { ok:false, reason:'creator_id required (cooper|charlie)' }, 400);
  if (!body.brand) return json(res, { ok:false, reason:'brand required' }, 400);

  // Build a unique deal id
  const slug = body.brand.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);
  const dealId = `${slug}-${body.creator_id}`;
  // If a deal with that id already exists, just link to it
  let deal = P.db().prepare('SELECT * FROM deals WHERE id=?').get(dealId);
  if (!deal) {
    // Pull contract details if this is a contract lead
    let postingDate = null, usageRights = null, exclusivityDays = null;
    if (kind === 'contract') {
      const c = P.db().prepare('SELECT * FROM contracts WHERE id=?').get(id);
      if (c) {
        try {
          const ex = JSON.parse(c.extracted || '{}');
          postingDate = ex.posting_date_iso || ex.posting_window_start_iso || null;
          usageRights = c.usage_rights || null;
          exclusivityDays = c.exclusivity_days || null;
        } catch {}
      }
    }
    P.db().prepare(`INSERT INTO deals (id, brand, brand_key, creator_id, funnel_stage, state,
      raw_stage, priority, ball_in_court, fee_cents, posting_date, usage_rights,
      exclusivity_days, primary_channel, last_activity_at, last_activity_by, next_action)
      VALUES (?, ?, ?, ?, 'in_works', 'open', 'contract_received', 'high', 'us', ?, ?, ?, ?, 'email',
        datetime('now'), 'them', 'Review terms, return signed')`)
      .run(dealId, body.brand, body.brand, body.creator_id,
           body.fee_cents || null, postingDate, usageRights, exclusivityDays);
    deal = P.db().prepare('SELECT * FROM deals WHERE id=?').get(dealId);
  }
  // Link the contract / mark notification as resolved
  if (kind === 'contract') {
    P.db().prepare(`UPDATE contracts SET deal_id=? WHERE id=?`).run(dealId, id);
  } else {
    P.db().prepare(`UPDATE notifications SET deal_id=?, dismissed_at=datetime('now') WHERE id=?`)
      .run(dealId, Number(id));
  }
  // Drop a banner so Riley sees the new deal
  P.db().prepare(`INSERT INTO notifications (kind, deal_id, title, body)
    VALUES ('lead_promoted', ?, ?, ?)`)
    .run(dealId,
         `📥 New deal: ${body.brand}`,
         body.fee_cents ? `Created from ${kind} — locked at $${(body.fee_cents/100).toLocaleString()}.` : `Created from ${kind}.`);
  json(res, { ok:true, deal });
});

// ---- Notifications (auto-promote banner + undo) -----------------------------
route('GET', '/api/notifications', async (req, res) => {
  const rows = listActiveNotifications({ db: P.db(), hours: 48 });
  // Hydrate with brand for the banner display
  const ids = rows.map(r => r.deal_id);
  const brands = ids.length
    ? Object.fromEntries(P.db().prepare(`SELECT id, brand, creator_id, fee_cents FROM deals
        WHERE id IN (${ids.map(()=>'?').join(',')})`).all(...ids).map(r => [r.id, r]))
    : {};
  json(res, rows.map(r => ({ ...r, deal: brands[r.deal_id] || null })));
});
route('POST', '/api/notifications/([0-9]+)/dismiss', async (req, res, { match }) => {
  json(res, dismissNotification({ db: P.db(), id: Number(match[1]) }));
});
route('POST', '/api/notifications/([0-9]+)/undo', async (req, res, { match }) => {
  json(res, undoPromotion({ db: P.db(), notificationId: Number(match[1]) }));
});

// ---- Intent preview + commit helpers ----------------------------------------
function previewIntent(intent) {
  switch (intent.intent) {
    case 'log_payment':
      return { kind: 'money', title: intent.brand ? `Log payment · ${intent.brand}` : 'Log payment',
        body: intent.amount_cents
          ? `Marks <b>$${(intent.amount_cents/100).toLocaleString()}</b> received on `
            + `<b>${intent.brand || 'this deal'}</b>${intent.creator_id ? ' for '+intent.creator_id : ''} → 80/10/10 split logged.`
          : 'Need an amount. Try "Garmin paid $6,500".' };
    case 'send_message': {
      const text = intent.message || '';
      const wantsWA = /\b(text|whatsapp|wa\b|message cooper|message charlie|tell cooper|tell charlie)\b/i.test(text);
      const wantsEmail = /\b(email|reply|gmail|back to|draft a email|write back)\b/i.test(text);
      const channel = wantsWA && !wantsEmail ? 'whatsapp' : 'email';
      if (channel === 'email') {
        return { kind:'draft', title:`✎ Email reply · ${intent.brand || 'brand'}`,
          body: `Cooks a Gmail draft to <b>${intent.brand || 'the brand'}</b> using this as guidance: <i>"${text}"</i>. Modal opens on Confirm so you can review + send.`,
          channel: 'email' };
      }
      return { kind:'draft', title:`💬 WhatsApp · ${(intent.creator_id||'creator')}`,
        body: 'Drafts a WhatsApp message to your creator — review before sending.', draft: text };
    }
    case 'flag_deal':
      return { kind:'flag', title: intent.brand ? `Flag · ${intent.brand}` : 'Flag deal',
        body: `Adds the note "<b>${intent.note}</b>" to ${intent.brand || 'the deal'}, bumps it to your move.` };
    case 'reminder':
      return { kind:'reminder', title:'Reminder',
        body: `<b>${intent.text}</b>${intent.due_at ? ' — due <b>'+intent.due_at+'</b>' : ''}.` };
    case 'change_stage':
      return { kind:'stage', title:`Move ${intent.brand || 'deal'} -> ${intent.to}`,
        body: 'Updates funnel stage and logs the move.' };
    case 'query':
      return { kind:'query', title:'Question',
        body: 'In the paid phase this routes through OpenAI for a real answer.' };
    default:
      return { kind:'note', title:'Note', body:'Logs as a free-text note.' };
  }
}

async function commitIntent(intent) {
  switch (intent.intent) {
    case 'log_payment':
      if (!intent.deal_id || !intent.amount_cents) return { ok:false, reason:'need deal + amount' };
      return P.data.logPayment({ id:`pay_${Date.now()}`, deal_id:intent.deal_id, amount_cents:intent.amount_cents });
    case 'reminder':
      return P.data.addReminder({ id:`rem_${Date.now()}`, text:intent.text, due_at:intent.due_at, source:'capture' });
    case 'flag_deal':
      P.data.log({ who:'riley', action:'flag_added', deal_id: intent.deal_id, summary: intent.note });
      return { ok:true, kind:'flag_added' };
    case 'send_message': {
      if (!intent.deal_id) return { ok:false, reason:'no matching deal to send on' };
      const deal = P.data.getDeal(intent.deal_id);
      if (!deal) return { ok:false, reason:'deal not found' };
      const instruction = intent.message || '';
      // Detect channel from the wording itself (overrides classifier guess).
      const wantsWA = /\b(text|whatsapp|wa\b|message cooper|message charlie|tell cooper|tell charlie)\b/i.test(instruction);
      const wantsEmail = /\b(email|reply|gmail|back to|draft a email|write back)\b/i.test(instruction);
      const channel = wantsWA && !wantsEmail ? 'whatsapp' : 'email';
      if (channel === 'whatsapp' && deal.creator_id) {
        // Ping the creator via WhatsApp — save as draft so the WA modal can open it.
        return P.data.saveDraft({
          id: `dr_${Date.now()}_${randomUUID().slice(0,6)}`,
          deal_id: intent.deal_id, channel: 'whatsapp',
          body: instruction, status: 'ready', generated_by: 'voice-capture',
          rationale: 'Voice-capture WA message',
        });
      }
      // EMAIL: cook a proper draft via the AI provider with Riley's instruction baked in.
      // Use pickReplyTarget so we never land in a Google Docs notification thread.
      const target = pickReplyTarget(intent.deal_id);
      const latestMsg = target
        ? P.db().prepare(`SELECT * FROM messages WHERE id=?`).get(target.msg_id)
        : P.db().prepare(`SELECT * FROM messages
            WHERE thread_id IN (SELECT id FROM threads WHERE deal_id=?) AND from_us=0
            ORDER BY sent_at DESC LIMIT 1`).get(intent.deal_id);
      try {
        const replyThreadId = target?.thread_id || deal.thread_id;
        const threadHistory = replyThreadId ? P.db().prepare(`
          SELECT id, sender, from_us, sent_at, snippet, body, channel
          FROM messages WHERE thread_id = ?
          ORDER BY sent_at DESC LIMIT 20`).all(replyThreadId).reverse() : [];
        const waHistory = P.db().prepare(`
          SELECT m.id, m.sender, m.from_us, m.sent_at, m.snippet, m.body, m.channel
          FROM messages m JOIN threads t ON t.id = m.thread_id
          WHERE t.deal_id = ? AND m.channel = 'whatsapp'
          ORDER BY m.sent_at DESC LIMIT 20`).all(intent.deal_id).reverse();
        const composed = await P.draft.draft({
          deal, latestMessage: latestMsg,
          mode: 'custom_instruction',
          customInstruction: instruction,
          threadHistory, waHistory,
        });
        const draftId = `dr_${Date.now()}_${randomUUID().slice(0,6)}`;
        P.data.saveDraft({
          id: draftId, deal_id: intent.deal_id, channel: 'email',
          thread_id: target?.thread_id || deal.thread_id,
          reply_to_msg_id: target?.msg_id || latestMsg?.id || deal.latest_msg_id,
          subject: composed.subject, body: composed.body,
          status: 'ready', rationale: composed.rationale,
          generated_by: composed.generated_by,
        });
        P.data.log({ who:'riley', action:'voice_email_draft', deal_id:intent.deal_id,
          summary:`Cooked email per instruction: ${instruction.slice(0,140)}` });
        return { ok:true, kind:'email_draft_ready', draft_id: draftId, channel:'email',
          deal_id: intent.deal_id, brand: deal.brand };
      } catch (e) {
        return { ok:false, reason: e.message };
      }
    }
    default:
      P.data.log({ who:'riley', action:'note', summary: intent.text || JSON.stringify(intent) });
      return { ok:true };
  }
}

// ---- Static file server -----------------------------------------------------
// Serve from public/, data/wa-media/, data/email-media/, and contracts/.
const MEDIA_DIR = join(ROOT, 'data', 'wa-media');
const EMAIL_MEDIA_DIR = join(ROOT, 'data', 'email-media');
const CONTRACTS_DIR = join(ROOT, 'contracts');
const MEDIA_MIME = { ...MIME,
  '.pdf':'application/pdf', '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc':'application/msword', '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4':'video/mp4', '.mov':'video/quicktime', '.mp3':'audio/mpeg', '.ogg':'audio/ogg',
  '.webp':'image/webp', '.gif':'image/gif', '.jpeg':'image/jpeg'
};
function serveStatic(req, res, pathname) {
  // Serve WA media + Email media + Contract PDFs (separate roots for safety).
  const mediaRoutes = [
    { prefix:'/wa-media/',    dir: MEDIA_DIR },
    { prefix:'/email-media/', dir: EMAIL_MEDIA_DIR },
    { prefix:'/contracts/',   dir: CONTRACTS_DIR },
  ];
  for (const mr of mediaRoutes) {
    if (pathname.startsWith(mr.prefix)) {
      const rel = pathname.replace(new RegExp('^' + mr.prefix), '');
      const p = normalize(join(mr.dir, rel));
      if (!p.startsWith(mr.dir)) return json(res, { error:'forbidden' }, 403);
      if (!existsSync(p) || statSync(p).isDirectory()) return json(res, { error:'not found' }, 404);
      const type = MEDIA_MIME[extname(p).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Disposition': req.headers['x-download'] ? 'attachment' : 'inline',
        'Cache-Control': 'private, max-age=86400',
      });
      return res.end(readFileSync(p));
    }
  }
  // Regular public files
  let p = normalize(join(PUBLIC, pathname === '/' ? '/index.html' : pathname));
  if (!p.startsWith(PUBLIC)) return json(res, { error: 'forbidden' }, 403);
  if (!existsSync(p) || statSync(p).isDirectory()) return json(res, { error: 'not found', path: pathname }, 404);
  const type = MIME[extname(p)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(readFileSync(p));
}

// ---- Server -----------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (m) return await r.handler(req, res, { url, match: m });
    }
    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    json(res, { error: 'not found' }, 404);
  } catch (e) {
    console.error(e);
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`✓ Triibe Platform listening on http://localhost:${PORT}`);
  console.log(`  data: sqlite (~/triibe-platform/data/triibe.db)`);
  console.log(`  ai:   ${P.spend.status().enabled ? 'ENABLED' : 'OFF (kill switch)'}`);
  // Reconcile thread state on boot — heals any drift accumulated since last run
  try {
    const r = reconcileThreadStates({ db: P.db() });
    if (r.threads_updated || r.deals_updated) {
      console.log(`  reconcile: ${r.threads_updated} threads + ${r.deals_updated} deals refreshed from messages`);
    }
  } catch (e) { console.error('  reconcile failed:', e.message); }
  // Forecaster — pre-warm cache on boot + every 10 min so /api/forecast
  // hits return instantly. Recomputes from current pipeline state, so any
  // deal changes (new send, audit promotion, etc.) propagate within 10 min.
  try {
    const warmForecast = async () => {
      for (const creator of ['cooper', 'charlie']) {
        try {
          const f = await computeForecast(creator);
          FORECAST_CACHE.set(creator, { forecast: f, ts: Date.now() });
        } catch {}
      }
    };
    warmForecast();
    setInterval(warmForecast, 10 * 60 * 1000);
    console.log('  forecaster: cache pre-warmed, refresh every 10min');
  } catch (e) { console.warn('  forecaster boot err:', e.message); }
  // Creator-chat propagator — bridges Cooper/Charlie WA chat updates to the
  // lifecycle audit + AI summary pipelines so "Sintra signed" in WA flows
  // through to that deal's pill without a manual nudge.
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey && P.cfg('ai_enabled','false') === 'true') {
      import('./engines/creator_chat_propagator.js').then(m => {
        m.startPropagator({ db: P.db(), apiKey, spend: P.spend });
      }).catch(e => console.warn('  creator_chat_propagator failed:', e.message));
    }
  } catch (e) { console.warn('  creator_chat_propagator boot err:', e.message); }
  // Auto-refresh WhatsApp every 5 minutes — uses the bridge's saved session.
  const WA_AUTO = P.cfg('wa_auto_pull', 'true') === 'true';
  if (WA_AUTO) {
    console.log('  wa:   auto-pull every 5 min (skipped when daemon is alive)');
    const tick = async () => {
      if (await waDaemonAlive()) return; // daemon holds the auth session; do NOT spawn pull.js
      runWhatsAppPull().catch(() => {});
    };
    setInterval(tick, 5 * 60 * 1000);
    // Longer delay (15s) so daemon has time to bind its HTTP port at boot before we tick.
    setTimeout(tick, 15000);
  } else {
    console.log('  wa:   auto-pull DISABLED (set wa_auto_pull=true in config to enable)');
  }
});
