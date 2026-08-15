// Append-only audit trail (NFR-05). Every sensitive money/inventory/discount
// mutation writes a row inside its own transaction so the audit and the effect
// commit together. audit_logs.id is a bigint identity; before/after are jsonb.
export async function writeAudit(client, {
  merchantId,
  actorUserId,
  action,
  entityType = null,
  entityId = null,
  before = {},
  after = {},
  requestId = null,
}) {
  await client.query(
    `insert into public.audit_logs
       (merchant_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, request_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      merchantId,
      actorUserId,
      action,
      entityType,
      entityId,
      JSON.stringify(before || {}),
      JSON.stringify(after || {}),
      requestId,
    ],
  );
}

/** Enqueue an integration_outbox event (spec 8.1 — part of each money txn). */
export async function enqueueOutbox(client, { merchantId, eventType, aggregateId, payload }) {
  await client.query(
    `insert into public.integration_outbox (merchant_id, event_type, aggregate_id, payload)
     values ($1,$2,$3,$4)`,
    [merchantId, eventType, aggregateId, JSON.stringify(payload || {})],
  );
}
