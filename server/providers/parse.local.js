// LocalStubParseProvider — turns a free-text "tell the desk" command into a
// structured intent (the routing the quick-capture FAB does in the mockup).
// Regex-only today; the OpenAI parse provider will plug into the same method
// signature and just be smarter.
export class LocalStubParseProvider {
  constructor(db) { this.db = db; }

  async classifyIntent(text) {
    const t = (text || '').trim();
    if (!t) return { intent: 'unknown', confidence: 0 };
    const low = t.toLowerCase();

    // money / payment
    if (/\b(paid|payment|collected|wired|deposit|invoice (?:was )?paid)\b/.test(low)) {
      return { intent: 'log_payment', ...extractMoney(t), ...extractBrand(t, this.db), confidence: 0.85 };
    }
    // message
    if (/^(text|message|dm|tell|let .* know|whatsapp)\b/i.test(t)) {
      return { intent: 'send_message', ...extractCreator(t), ...extractMessage(t), confidence: 0.8 };
    }
    // flag / note
    if (/\b(flag|redline|red ?line|perpetual|exclusiv|risk|watch out)\b/i.test(t)) {
      return { intent: 'flag_deal', ...extractBrand(t, this.db), note: t, confidence: 0.75 };
    }
    // reminder
    if (/\b(remind|chase|follow up|nudge|tomorrow|next week|on (mon|tue|wed|thu|fri|sat|sun))\b/i.test(t)) {
      return { intent: 'reminder', text: t, due_at: extractDate(t), confidence: 0.75 };
    }
    // stage move
    if (/\b(move|promote|advance|mark as|set to)\b.*\b(cold|conversation|pitching|in works|active|completed|signed|dead)\b/i.test(low)) {
      return { intent: 'change_stage', ...extractBrand(t, this.db), to: extractStage(low), confidence: 0.7 };
    }
    // ask question
    if (/^(what|who|when|how much|how many|why|where|show me|list)\b/i.test(t)) {
      return { intent: 'query', q: t, confidence: 0.6 };
    }
    return { intent: 'note', text: t, confidence: 0.4 };
  }
}

function extractMoney(t) {
  const m = t.match(/\$?\s?([\d,]+(?:\.\d{2})?)\s?(k|K)?/);
  if (!m) return {};
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (m[2]) n *= 1000;
  return { amount_cents: Math.round(n * 100) };
}
function extractBrand(t, db) {
  // greedy heuristic: capitalized word(s); then verify against deals table
  const words = t.match(/\b[A-Z][A-Za-z0-9.&+\-]+(?:\s+[A-Z][A-Za-z0-9.&+\-]+)?/g) || [];
  for (const w of words) {
    const row = db.prepare('SELECT id, brand, creator_id FROM deals WHERE LOWER(brand) LIKE ?').get('%' + w.toLowerCase() + '%');
    if (row) return { deal_id: row.id, brand: row.brand, creator_id: row.creator_id };
  }
  return {};
}
function extractCreator(t) {
  if (/\bcooper\b/i.test(t))  return { creator_id: 'cooper' };
  if (/\bcharlie\b/i.test(t)) return { creator_id: 'charlie' };
  return {};
}
function extractMessage(t) {
  // crude: text after "Charlie/Cooper" name
  const m = t.match(/(?:cooper|charlie)\s+(.*)$/i);
  return m ? { message: m[1].trim() } : { message: t };
}
function extractDate(t) {
  const today = new Date();
  if (/\btomorrow\b/i.test(t)) { const d = new Date(today); d.setDate(d.getDate()+1); return d.toISOString().slice(0,10); }
  if (/\bnext week\b/i.test(t)) { const d = new Date(today); d.setDate(d.getDate()+7); return d.toISOString().slice(0,10); }
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b${days[i]}(?:day)?\\b`, 'i').test(t)) {
      const d = new Date(today); const delta = ((i - d.getDay()) + 7) % 7 || 7;
      d.setDate(d.getDate() + delta); return d.toISOString().slice(0,10);
    }
  }
  return null;
}
function extractStage(low) {
  const map = { 'cold':'cold','conversation':'conversation','pitching':'pitching',
                'in works':'in_works','active':'active','completed':'completed',
                'signed':'in_works','dead':'completed' };
  for (const k of Object.keys(map)) if (low.includes(k)) return map[k];
  return null;
}
