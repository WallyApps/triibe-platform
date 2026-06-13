// reconcile.js — derive thread + deal state from the actual messages table.
//
// The truth source is messages. Threads + deals carry denormalized tracking
// columns (last_message_at, last_message_by, ball_in_court) that can drift
// when messages get inserted via different paths (bulk Gmail sync vs. single
// pullSingleThread vs. our own outbound being re-indexed).
//
// This module re-derives those columns from MAX(sent_at) per thread + the
// from_us flag of that latest message. Idempotent + cheap — one SQL pass per
// table, no AI cost.

/**
 * Reconcile every thread that has at least one message.
 * Returns: { threads_updated: n, deals_updated: m }
 *
 * Ball rule:
 *   - last message from us       → ball on them (brand)
 *   - last message from brand    → ball on us (Riley needs to reply)
 *
 * Empty threads (no messages) are left alone — could be just-created skeletons.
 */
export async function reconcileThreadStates({ db }) {
  // Single SQL update — for every thread, set last_message_at/by/ball based on
  // the latest message row. COALESCE keeps the row alive if no messages exist.
  const r1 = await db.prepare(`
    UPDATE threads
    SET last_message_at = COALESCE(
          (SELECT m.sent_at FROM messages m
           WHERE m.thread_id = threads.id
           ORDER BY m.sent_at DESC, m.id DESC LIMIT 1),
          last_message_at),
        last_message_by = COALESCE(
          (SELECT CASE WHEN m.from_us = 1 THEN 'us' ELSE 'them' END
           FROM messages m
           WHERE m.thread_id = threads.id
           ORDER BY m.sent_at DESC, m.id DESC LIMIT 1),
          last_message_by),
        ball_in_court = COALESCE(
          (SELECT CASE WHEN m.from_us = 1 THEN 'them' ELSE 'us' END
           FROM messages m
           WHERE m.thread_id = threads.id
           ORDER BY m.sent_at DESC, m.id DESC LIMIT 1),
          ball_in_court),
        updated_at = datetime('now')
    WHERE EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id)`).run();

  // BEFORE updating deals: capture which deals are about to flip from
  // ball=brand → ball=us (a new inbound message arrived since last reconcile).
  // We need that diff so we can invalidate stale next_action_detail text + the
  // AI summary on flipped deals — otherwise the headline keeps saying "no
  // action needed until they respond" even after they responded.
  const flipped = await db.prepare(`
    SELECT deals.id, deals.next_action_detail, deals.last_activity_at as old_activity_at,
           t.last_message_at as new_activity_at, t.last_message_by as new_activity_by,
           (SELECT m.sender FROM messages m
            WHERE m.thread_id = t.id ORDER BY m.sent_at DESC LIMIT 1) as new_sender
    FROM deals
    JOIN threads t ON t.deal_id = deals.id
    WHERE deals.ball_in_court = 'brand'
      AND t.ball_in_court = 'us'
      AND t.last_message_at > COALESCE(deals.last_activity_at, '1970-01-01')
      AND deals.state IN ('open','won')
  `).all();

  // Propagate to deals: when a deal has exactly one most-recently-active thread,
  // sync deal.ball_in_court + deal.last_activity_at to that thread's truth.
  // Skip deals where there are competing threads with conflicting ball states
  // (rare — usually means Riley has WhatsApp + email both alive; in that case
  // keep whatever's there since the per-deal pill shows both anyway).
  const r2 = await db.prepare(`
    UPDATE deals
    SET ball_in_court = (
          SELECT CASE WHEN t.ball_in_court = 'us' THEN 'us'
                      WHEN t.ball_in_court = 'them' THEN 'brand'
                      ELSE deals.ball_in_court END
          FROM threads t
          WHERE t.deal_id = deals.id
          ORDER BY t.last_message_at DESC LIMIT 1),
        last_activity_at = COALESCE(
          (SELECT t.last_message_at FROM threads t
           WHERE t.deal_id = deals.id
           ORDER BY t.last_message_at DESC LIMIT 1),
          last_activity_at),
        last_activity_by = COALESCE(
          (SELECT t.last_message_by FROM threads t
           WHERE t.deal_id = deals.id
           ORDER BY t.last_message_at DESC LIMIT 1),
          last_activity_by),
        updated_at = datetime('now')
    WHERE EXISTS (SELECT 1 FROM threads t WHERE t.deal_id = deals.id)
      AND state IN ('open','won')`).run();

  // For each flipped deal: clear stale next_action_detail (which probably said
  // "no action needed until they respond") + invalidate the AI summary so it
  // gets re-cooked on next pill view. The text we leave behind is intentionally
  // honest: "new reply, needs read." The AI summary will refresh with the
  // actual context next time anyone opens the pill.
  const cleanupStmt = db.prepare(`
    UPDATE deals
    SET next_action = 'Read + reply to ' || COALESCE(?, 'brand') || '''s new message',
        next_action_detail = ? ,
        ai_summary_for = NULL,
        updated_at = datetime('now')
    WHERE id = ?`);
  for (const f of flipped) {
    const senderClean = (f.new_sender || '').split('<')[0].trim().replace(/"/g, '').slice(0, 40) || 'brand';
    const when = (f.new_activity_at || '').slice(0, 10);
    const detail = `[auto-reconciled ${new Date().toISOString().slice(0,16).replace('T',' ')}] NEW REPLY received ${when} from ${senderClean}. Ball just flipped to us, message needs read + reply. Headline summary will refresh on pill open.`;
    await cleanupStmt.run(senderClean, detail, f.id);
  }

  return {
    threads_updated: r1.changes,
    deals_updated: r2.changes,
    flipped_deals: flipped.length,
    flipped_ids: flipped.map(f => f.id),
  };
}
