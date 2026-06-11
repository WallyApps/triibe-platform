// InboundProvider — receives new Gmail/WhatsApp messages and writes them to
// threads/messages. The local stub is a NO-OP (so you can test without Gmail
// access). The real version will be Gmail API + the existing reconcile.py
// data, then later Google Pub/Sub push for true event-driven 24/7.
export class LocalStubInboundProvider {
  constructor(db) { this.db = db; }
  async pull() { return { new_messages: 0, source: 'local-stub' }; }
  async pushHandler(/* req */) { return { ok: false, reason: 'inbound provider not wired (free phase)' }; }
}
