// LocalStubDraftProvider — composes a draft using your negotiation playbook
// rules WITHOUT calling an AI. Honors voice, rate floors, and red lines so
// you can see the whole loop run before we pay for tokens. When the OpenAI
// provider lands, it implements `draft({deal, latestMessage, mode})` the same
// way and just gets a richer composition.
import { suggestPrice } from '../engines/pricing.js';

export class LocalStubDraftProvider {
  constructor(db) { this.db = db; }

  // mode: 'counter' | 'ask_brief' | 'channel_switch' | 'gentle_nudge'
  async draft({ deal, latestMessage = null, mode = 'counter' }) {
    const firstName = (deal.contact_name || 'there').split(/\s+/)[0];
    const sug = suggestPrice(deal);
    const brand = deal.brand;

    let body, rationale;
    if (mode === 'channel_switch') {
      body = `Hey ${firstName},\n\nAppreciate the back-and-forth on ${brand}. Happy to keep moving — `
           + `honestly we close these faster on WhatsApp. What's the best number to ping you on?\n\n`
           + `Best,\nRiley Wallack\nTriibe Talents`;
      rationale = `Channel-switch ask: email deals tend to drag; WhatsApp closes 2-3x faster.`;
    } else if (mode === 'ask_brief') {
      body = `Hey ${firstName},\n\nAppreciate you reaching out about ${brand}. `
           + `honestly feels potentially aligned — before I lock anything down, could you send through:\n\n`
           + `• full brief / creative direction\n• posting window\n• usage rights & exclusivity asks\n• payment terms\n\n`
           + `Once I've got that I'll come back with a tight quote.\n\n`
           + `Best,\nRiley Wallack\nTriibe Talents`;
      rationale = `Ask-for-brief: gather inputs before quoting (playbook rule).`;
    } else if (mode === 'gentle_nudge') {
      body = `Hey ${firstName},\n\nCircling back on ${brand} — wanted to make sure my last note didn't get buried. `
           + `Happy to walk through anything if it's easier on a quick call.\n\n`
           + `Best,\nRiley Wallack\nTriibe Talents`;
      rationale = `Nudge: thread idle, ball was on brand.`;
    } else {
      // counter / quote
      const askLine = sug.suggested_cents
        ? `For ${describeDeliverable(deal)} we'd land at ${fmtUsd(sug.suggested_cents)} — `
          + `${sug.note}`
        : `Happy to send a tight quote once we lock the deliverable.`;
      body = `Hey ${firstName},\n\nAppreciate the context on ${brand}. honestly feels very aligned `
           + `with ${creatorBlurb(deal.creator_id)}.\n\n${askLine}\n\n`
           + `If you've got room there, happy to discuss usage and timing in the same pass.\n\n`
           + `Looking forward to hearing your thoughts.\n\n`
           + `Best,\nRiley Wallack\nTriibe Talents`;
      rationale = `Counter @ ${fmtUsd(sug.suggested_cents)} — floor ${fmtUsd(sug.floor_cents)}, anchor ${fmtUsd(sug.anchor_cents)}. ${sug.reasoning}`;
    }

    return {
      body,
      subject: deal.primary_channel === 'email' ? `Re: ${brand} × ${creatorName(deal.creator_id)}` : null,
      rationale,
      suggested_price_cents: sug.suggested_cents,
      generated_by: 'local-stub',
    };
  }
}

function describeDeliverable(d) {
  const cat = d.category || '';
  if (d.creator_id === 'charlie') return 'a dedicated IG Reel + 30-day link in bio';
  if (d.creator_id === 'cooper')  return 'a dedicated IG Reel (organic, 30-day)';
  return 'the dedicated Reel';
}
function creatorBlurb(c) {
  if (c === 'charlie') return `Charlie's outdoor / adventure audience — the type of content that performs best there`;
  if (c === 'cooper')  return `Cooper's AI/SaaS audience — the kind of post that lands well`;
  return `the creator's audience`;
}
function creatorName(c) { return c === 'cooper' ? 'Cooper' : c === 'charlie' ? 'Charlie' : (c || ''); }
function fmtUsd(c) { return c == null ? '—' : '$' + Math.round(c/100).toLocaleString(); }
