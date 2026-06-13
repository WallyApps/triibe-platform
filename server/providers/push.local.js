// PushProvider — phone/desktop notifications. Local stub writes to console.
// Real version: Web Push (VAPID) so an installed PWA gets notifications even
// when the tab is closed. Works on Mac + iPhone PWAs.
export class LocalPushProvider {
  constructor(db) { this.db = db; }
  async notify({ title, body, deal_id = null }) {
    console.log(`[push:local] ${title} — ${body}${deal_id ? ' (' + deal_id + ')' : ''}`);
    await this.db.prepare(`INSERT INTO activity_log (who, action, deal_id, summary)
                     VALUES ('system', 'notify_local', ?, ?)`).run(deal_id, `${title} — ${body}`);
    return { delivered: true, channel: 'console' };
  }
}
