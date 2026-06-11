import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const db = new DatabaseSync('./data/triibe.db');

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) { console.error('No OPENAI_API_KEY'); process.exit(1); }

// Load rate card
const card = JSON.parse(readFileSync('./config/rate_card.json', 'utf8'));

// Import the playbook + voice samples helper from our provider
const { stripQuotedReply } = await import('./server/providers/inbound.gmail.js');

// Pull last 5 of Riley's real emails as voice samples
const voiceRows = db.prepare(`SELECT body FROM messages WHERE from_us=1 AND channel='email'
  AND body IS NOT NULL AND length(body) BETWEEN 150 AND 1500
  AND body NOT LIKE '%---%' AND body NOT LIKE '%unsubscribe%'
  ORDER BY sent_at DESC LIMIT 5`).all();
const voiceSamples = voiceRows.map((r, i) => {
  let b = stripQuotedReply(r.body) || r.body;
  b = b.replace(/\s+/g, ' ').trim().slice(0, 800);
  return `EXAMPLE ${i+1}: "${b}"`;
}).join('\n\n');

const PLAYBOOK = `You're drafting an email Riley Wallack will literally send. He runs Triibe Talents — manages Cooper Simson (78K IG, AI/SaaS) and Charlie Stringer (306K IG + 233K TikTok, outdoor).

CORE STYLE:
- SHORT. 3-5 sentences max. Long emails are an AI tell.
- Direct. Get to the point in sentence one. No "Hope you're well".
- Plain language. Contractions. Confident, not deferential.
- Specific over general.

BANNED PHRASES:
- "I appreciate" / "happy to" / "looking forward to hearing your thoughts"
- "Circling back" / "Just wanted to check in" / "Touching base"
- "Hope this finds you well"
- "Please don't hesitate to" / "Feel free to"
- "honestly" as softener
- em-dash filler

RATES:
- Cooper IG Reel: $4,000 standard / $3,000 floor.
- Charlie: IG Reel $4,500 / TikTok $2,500 / Story $1,500 / UGC $1,000.
- Push ZERO exclusivity. Accept 30d only if pressed. Redline 90+.
- Recurring: plant seed early ("worth running one as a test first?").
- Net 30 default. Net 90+ flag.

OUTPUT FORMAT:
- ONLY the email body. No subject line.
- 3-5 sentences. Sign-off: Best,\\nRiley Wallack\\nTriibe Talents

${voiceSamples ? `\nRILEY'S ACTUAL VOICE — recent emails. Mimic this:\n${voiceSamples}` : ''}`;

async function cookReply({ subject, sender, body, creator, brand, isNewPitch }) {
  const creatorCap = creator ? creator[0].toUpperCase() + creator.slice(1) : 'creator';
  const rates = creator && card[creator] ? card[creator] : null;
  const rateLines = rates ? [
    rates.ig_reel_cents ? `IG Reel $${(rates.ig_reel_cents/100).toLocaleString()}` : '',
    rates.tiktok_cents ? `TikTok $${(rates.tiktok_cents/100).toLocaleString()}` : '',
    rates.ig_story_cents ? `IG Story $${(rates.ig_story_cents/100).toLocaleString()}` : '',
    rates.ugc_cents ? `UGC $${(rates.ugc_cents/100).toLocaleString()}` : '',
    rates.floor_cents ? `(Floor $${(rates.floor_cents/100).toLocaleString()})` : '',
  ].filter(Boolean).join(' · ') : '(no rate card available)';

  const taskLine = isNewPitch
    ? `This is a NEW PITCH — first reply. Open with rate card breakdown for the scope they mentioned. Don't dance around price.`
    : `Reply to brand's latest message. Reference any anchors already in thread.`;

  const user = `${taskLine}

CREATOR: ${creatorCap}
${creator ? `${creatorCap}'s rates: ${rateLines}` : ''}
BRAND: ${brand}

EMAIL TO REPLY TO:
Subject: ${subject}
From: ${sender}
Body: ${body.slice(0, 2000)}

Write Riley's reply now. 3-5 sentences. Sign Best,\\nRiley Wallack\\nTriibe Talents.`;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method:'POST', headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
    body: JSON.stringify({
      model:'gpt-4o', temperature:0.55, max_tokens:500,
      messages:[{role:'system',content:PLAYBOOK},{role:'user',content:user}],
    }),
  });
  const data = await r.json();
  return data.choices?.[0]?.message?.content?.trim() || '(no draft)';
}

// 1) Unmatched pitches (new emails)
const pitches = JSON.parse(await (await fetch('http://localhost:4744/api/inbox-pitches')).text());
const skipCreators = new Set(['beth', 'amie']);  // not on our platform — skip drafting
const pitchesToDraft = pitches.filter(p => !skipCreators.has(p.creator_guess));

// 2) Existing deals needing reply
const cooperInbox = JSON.parse(await (await fetch('http://localhost:4744/api/inbox?creator=cooper&filter=needs-reply')).text());
const charlieInbox = JSON.parse(await (await fetch('http://localhost:4744/api/inbox?creator=charlie&filter=needs-reply')).text());
const inboxAll = [...cooperInbox, ...charlieInbox];

console.log('\n# 📋 Reply drafts — paste straight into Gmail\n');
console.log(`_${pitchesToDraft.length} new pitches + ${inboxAll.length} existing-deal replies_\n`);

console.log('\n---\n## 📨 NEW PITCHES\n---');
for (const p of pitchesToDraft) {
  const creator = p.creator_guess && p.creator_guess !== 'unknown' ? p.creator_guess : 'cooper';  // default cooper if unsure
  console.log(`\n### ${p.brand}`);
  console.log(`**Subject:** ${p.subject}`);
  console.log(`**From:** ${p.sender}`);
  console.log(`**Guessed creator:** ${creator}${p.creator_guess === 'unknown' ? ' (UNSURE)' : ''}`);
  console.log();
  const draft = await cookReply({
    subject: p.subject, sender: p.sender, body: p.body,
    creator, brand: p.brand, isNewPitch: true,
  });
  console.log('```');
  console.log(draft);
  console.log('```\n');
}

console.log('\n---\n## 📧 EXISTING DEALS NEEDING REPLY\n---');
for (const ix of inboxAll) {
  if (ix.channel !== 'email') { 
    console.log(`\n### ${ix.brand} (${ix.channel} — handle in app)\n`);
    continue;
  }
  console.log(`\n### ${ix.brand} (${ix.creator_id})`);
  console.log(`**Stage:** ${ix.raw_stage} · **Age:** ${ix.age_hours}h ago`);
  console.log();
  const draft = await cookReply({
    subject: '(reply)', sender: ix.sender || 'brand', body: ix.body || ix.snippet || '',
    creator: ix.creator_id, brand: ix.brand, isNewPitch: false,
  });
  console.log('```');
  console.log(draft);
  console.log('```\n');
}

db.close();
