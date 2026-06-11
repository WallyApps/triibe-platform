// WhatsAppSendProvider — outbound WhatsApp sends. STUB never sends.
// Two real options later: (1) whatsapp-web.js bridge (unofficial, ban risk —
// human-paced, active chats only, kill switch), (2) WhatsApp Business Cloud
// API (official, compliant). Either implements `send({chat_id, text})`.
export class LocalWhatsAppSendProvider {
  constructor(db) { this.db = db; }
  async send({ chat_id, text, deal_id = null }) {
    console.log(`[wa:local-stub] would send to ${chat_id}: ${text.slice(0, 80)}…`);
    this.db.prepare(`INSERT INTO activity_log (who, action, deal_id, summary, meta)
                     VALUES ('system', 'wa_send_stubbed', ?, ?, ?)`)
      .run(deal_id, 'WhatsApp send intercepted (stub)', JSON.stringify({ chat_id }));
    return { sent: false, reason: 'WhatsApp send provider not wired (free phase). Approve in build phase to enable.' };
  }
}
