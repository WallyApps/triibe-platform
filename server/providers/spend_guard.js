// SpendGuard — the safety belt that sits between the app and any paid AI
// provider. Three layers of protection:
//
//   1. ai_enabled kill switch (master off)
//   2. Per-hour call cap + per-day token budget
//   3. Monthly $ cap (mirror of OpenAI dashboard cap — defense in depth)
//
// Every paid call MUST go through `attempt()` and `record()`. If `attempt()`
// returns false, we silently skip (no surprise charges, ever).
export class SpendGuard {
  constructor(db) { this.db = db; }

  cfg(key, fallback = null) {
    const r = this.db.prepare('SELECT value FROM config WHERE key=?').get(key);
    return r ? r.value : fallback;
  }

  status() {
    const enabled = this.cfg('ai_enabled', 'false') === 'true';
    const monthlyCap = parseInt(this.cfg('ai_monthly_cap_cents', '2000'), 10);
    const tokenBudget = parseInt(this.cfg('ai_daily_token_budget', '500000'), 10);
    const callCap = parseInt(this.cfg('ai_max_calls_per_hour', '60'), 10);

    const monthSpend = this.db.prepare(`SELECT COALESCE(SUM(est_cost_cents),0) v FROM ai_usage
      WHERE ts >= date('now','start of month')`).get().v;
    const dayTokens = this.db.prepare(`SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) v
      FROM ai_usage WHERE ts >= date('now')`).get().v;
    const hourCalls = this.db.prepare(`SELECT COUNT(*) c FROM ai_usage
      WHERE ts >= datetime('now','-1 hour')`).get().c;

    return {
      enabled,
      caps:  { monthly_cents: monthlyCap, daily_tokens: tokenBudget, hourly_calls: callCap },
      usage: { month_cents: monthSpend, day_tokens: dayTokens, hour_calls: hourCalls },
      headroom_cents: Math.max(0, monthlyCap - monthSpend),
      pct_of_cap: monthlyCap > 0 ? Math.min(100, Math.round(100 * monthSpend / monthlyCap)) : 0,
    };
  }

  // returns { ok: bool, reason }
  attempt({ dedupe_key } = {}) {
    const s = this.status();
    if (!s.enabled) return { ok: false, reason: 'AI is OFF (kill switch). Flip ai_enabled in config to turn on.' };
    if (s.usage.month_cents >= s.caps.monthly_cents)
      return { ok: false, reason: `Monthly cap hit ($${s.caps.monthly_cents/100}). Waits until next month or raise the cap.` };
    if (s.usage.day_tokens >= s.caps.daily_tokens)
      return { ok: false, reason: 'Daily token budget exhausted. Resets at midnight.' };
    if (s.usage.hour_calls >= s.caps.hourly_calls)
      return { ok: false, reason: 'Hourly call cap hit. Throttled.' };

    if (dedupe_key) {
      const dup = this.db.prepare('SELECT id FROM ai_usage WHERE dedupe_key=?').get(dedupe_key);
      if (dup) return { ok: false, reason: 'Dedupe: this exact input was already processed.' };
    }
    return { ok: true, status: s };
  }

  record({ provider, model, operation, prompt_tokens = 0, completion_tokens = 0,
           est_cost_cents = 0, deal_id = null, dedupe_key = null }) {
    this.db.prepare(`INSERT INTO ai_usage (provider, model, operation,
        prompt_tokens, completion_tokens, est_cost_cents, deal_id, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(provider, model, operation, prompt_tokens, completion_tokens, est_cost_cents, deal_id, dedupe_key);

    // budget-alert flags (so the UI can show a banner at 50/80%)
    const s = this.status();
    if (s.pct_of_cap >= 80 && this.cfg('ai_budget_alert_80') !== 'true')
      this.db.prepare(`UPDATE config SET value='true', updated_at=datetime('now') WHERE key='ai_budget_alert_80'`).run();
    if (s.pct_of_cap >= 50 && this.cfg('ai_budget_alert_50') !== 'true')
      this.db.prepare(`UPDATE config SET value='true', updated_at=datetime('now') WHERE key='ai_budget_alert_50'`).run();
  }
}
