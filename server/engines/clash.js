// Clash engine — port of ~/triibe-ops/tools/clash_check.py logic into JS.
// Rules (from Riley's playbook & feedback):
//   * EXCLUSIVITY = HARD BLOCK. Posting a competitor inside an exclusivity
//     window of an active deal is the only thing that auto-stops a draft.
//   * AI-spacing & ±7-day category concentration = WARN, not block. Never
//     drop money over spacing; just surface it so Riley sees.
//   * Blackout windows (from data) = WARN.
//   * raw_footage_no_posting deals are EXEMPT from posting clashes.

const SPACING_DAYS = 7;       // same-creator, same-category recommended gap
const AI_SPACING_DAYS = 3;    // AI/SaaS category is tighter

export function computeClashes(deals, blackouts = []) {
  const out = [];
  const byCreator = {};
  for (const d of deals) {
    if (d.state !== 'open' && d.state !== 'won') continue;
    if (d.raw_footage_no_posting) continue;
    (byCreator[d.creator_id] ||= []).push(d);
  }

  for (const [creator, list] of Object.entries(byCreator)) {
    // brand_duplicate within same creator
    const seen = new Map();
    for (const d of list) {
      const key = d.brand_key || d.brand?.toLowerCase();
      if (!key) continue;
      if (seen.has(key)) {
        out.push({ kind:'brand_duplicate', severity:'warn',
          creator_id:creator, deal_a:seen.get(key).id, deal_b:d.id,
          detail:`Same brand "${d.brand}" appears twice for ${creator} — likely merged dupes from multiple reps.` });
      } else seen.set(key, d);
    }

    // pairwise checks
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.category && b.category && a.category === b.category) {
          // exclusivity hard block
          const exclHit = exclusivityConflict(a, b);
          if (exclHit) out.push({ kind:'exclusivity_block', severity:'block',
            creator_id:creator, deal_a:a.id, deal_b:b.id, detail:exclHit });

          // spacing / concentration warn
          const spacing = postingTooClose(a, b);
          if (spacing) out.push({ kind: a.category === 'ai_saas' ? 'ai_spacing' : 'category_concentration',
            severity:'warn', creator_id:creator, deal_a:a.id, deal_b:b.id, detail:spacing });
        }
      }
    }
    // category concentration: >5 active in same category for one creator
    const catCounts = {};
    for (const d of list) if (d.category) catCounts[d.category] = (catCounts[d.category] || 0) + 1;
    for (const [cat, n] of Object.entries(catCounts)) {
      if (n > 5) out.push({ kind:'category_concentration', severity:'warn',
        creator_id:creator, detail:`${n} active ${cat} deals for ${creator} — heavy concentration risk.` });
    }
  }

  // blackouts
  for (const bo of blackouts) {
    for (const d of deals) {
      if (!d.posting_date) continue;
      if (d.posting_date >= bo.start && d.posting_date <= bo.end) {
        out.push({ kind:'blackout', severity:'warn',
          creator_id:d.creator_id, deal_a:d.id,
          detail:`${d.brand} posting ${d.posting_date} falls inside blackout: ${bo.name}` });
      }
    }
  }

  return out;
}

function exclusivityConflict(a, b) {
  // Only if at least one explicitly requires exclusivity in the category.
  if (!a.exclusivity_required && !b.exclusivity_required) return null;
  const aWin = window(a), bWin = window(b);
  if (!aWin || !bWin) return null;
  // overlap?
  if (aWin.end < bWin.start || bWin.end < aWin.start) return null;
  return `${a.brand} requires ${a.exclusivity_days || '?'}d exclusivity in ${a.category}, `
       + `overlapping ${b.brand} posting window ${bWin.start} -> ${bWin.end}.`;
}

function postingTooClose(a, b) {
  if (!a.posting_date || !b.posting_date) return null;
  const gap = Math.abs(dayDiff(a.posting_date, b.posting_date));
  const limit = a.category === 'ai_saas' ? AI_SPACING_DAYS : SPACING_DAYS;
  if (gap < limit) return `${a.brand} & ${b.brand} posting ${gap}d apart (recommend ≥${limit}d in ${a.category}).`;
  return null;
}

function window(d) {
  const start = d.posting_window_start || d.posting_date;
  const end   = d.posting_window_end   || d.posting_date;
  if (!start || !end) return null;
  // extend end by exclusivity window if present
  const exclEnd = d.exclusivity_days ? addDays(end, d.exclusivity_days) : end;
  return { start, end: exclEnd };
}

function dayDiff(a, b) {
  return Math.round((new Date(a) - new Date(b)) / 86400000);
}
function addDays(iso, n) {
  const d = new Date(iso); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// "Can [creator] do [category] on [date]?" — pre-commit check for the FAB.
export function canDo({ deals, creator, category, date }) {
  const target = { creator_id: creator, category, posting_date: date,
                   posting_window_start: date, posting_window_end: date,
                   exclusivity_required: true };
  const clashes = computeClashes([...deals, target]);
  const blockers = clashes.filter(c => (c.deal_a === undefined || c.deal_b === undefined || c.deal_a === 'pre' || c.deal_b === 'pre' || c.deal_a === '__pre' || c.deal_b === '__pre' || true) && c.severity === 'block');
  const warns = clashes.filter(c => c.severity === 'warn');
  return {
    verdict: blockers.length ? 'blocked' : warns.length ? 'tight' : 'clear',
    blockers, warnings: warns
  };
}
