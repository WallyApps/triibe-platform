// Extract text from a contract/brief file (PDF or DOCX), then use AI to pull
// out the structured terms we care about (fee, dates, usage rights, exclusivity,
// payment terms, redlines).
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

// Both pdf-parse and mammoth are CommonJS — use createRequire to load them.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');

export async function extractText(filePath) {
  const buf = readFileSync(filePath);
  const ext = extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    const parser = new PDFParse({ data: buf });
    const r = await parser.getText();
    return { text: r.text || '', pages: r.total_pages || r.pages || null, kind: 'pdf' };
  }
  if (ext === '.docx') {
    const r = await mammoth.extractRawText({ buffer: buf });
    return { text: r.value || '', kind: 'docx' };
  }
  if (ext === '.txt' || ext === '.md') {
    return { text: buf.toString('utf8'), kind: ext.slice(1) };
  }
  throw new Error('Unsupported file type: ' + ext);
}

// AI-extract structured terms. Returns { fee_cents, payment_terms, usage_rights,
// usage_expiry, exclusivity_days, posting_date, redline_flags[], deliverable, ... }
export async function aiExtractTerms({ text, brand, dealAgreedTerms }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  // Truncate to ~15K tokens (60K chars) to keep cost in check
  const clipped = text.length > 60_000 ? text.slice(0, 60_000) + '\n…[truncated]' : text;

  const sys = `You extract influencer contract terms from raw text.
Return ONLY a JSON object. Fields:
  fee_usd (number or null)
  payment_terms (string, e.g. "net-30 from invoice", or null)
  usage_rights (string short summary, e.g. "30-day organic + paid amp 90d")
  usage_expiry_iso (YYYY-MM-DD if specific, else null)
  exclusivity_days (integer or null)
  exclusivity_categories (array of strings or null, e.g. ["ai_saas"])
  posting_date_iso (YYYY-MM-DD or null)
  posting_window_start_iso (YYYY-MM-DD or null)
  posting_window_end_iso (YYYY-MM-DD or null)
  deliverable (string short)
  brand_party (string — the brand entity from the contract)
  creator_party (string — the creator/agency entity)
  redline_flags (array of strings — any of: "perpetual_usage", "exclusivity_over_90d", "net_60_or_longer", "unspecified_usage", "blank_fields", "personal_info_requested", "ip_transfer_to_brand", "termination_for_convenience_to_brand", "no_creator_approval_clause")
  is_brief (boolean — true if this looks like a campaign BRIEF rather than a signed contract)
  summary (string — 1-2 sentence plain-English summary of the terms)

  obligations (array of objects — what the CREATOR is contractually required to do):
    Each item: {
      type: "post" | "sign" | "deliver_asset" | "grant_usage" | "include_disclosure" | "honor_exclusivity" | "submit_for_approval" | "other",
      what: short description (e.g. "1 Instagram Reel", "30-day ad code"),
      when: YYYY-MM-DD or string like "within 14 days of invoice" or null,
      required: true | false
    }
    ONLY include obligations EXPLICITLY in the contract text. Brand-side soft asks
    (e.g. "publish your Helper to the marketplace", "share metrics weekly") are NOT
    contract obligations unless the contract specifically requires them.
If a field is unclear, use null. Never guess.`;

  const userExtra = (dealAgreedTerms && Object.keys(dealAgreedTerms).length)
    ? `\n\nWHAT RILEY THINKS WAS AGREED (compare against contract — note discrepancies in summary):\n${JSON.stringify(dealAgreedTerms, null, 2)}`
    : '';
  const user = `BRAND: ${brand || '(unknown)'}
${userExtra}

CONTRACT/BRIEF TEXT:
${clipped}`;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',  // gpt-4o (not mini) — contracts deserve the smarter model
      temperature: 0.1, max_tokens: 1500,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error('OpenAI extract failed: ' + r.status);
  const data = await r.json();
  let parsed = {};
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}'); } catch {}
  return {
    extracted: parsed,
    usage: data.usage,
    est_cost_cents: Math.round((data.usage?.prompt_tokens || 0) * 0.00025)
                  + Math.round((data.usage?.completion_tokens || 0) * 0.001),
  };
}
