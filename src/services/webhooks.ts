/**
 * Webhook Processing Service for iPaymu payment callbacks.
 * Handles signature validation, idempotency, and payment state transitions.
 *
 * Requirements: 5.3, 5.4, 5.5, 5.6, 5.9, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 */

import type { IPaymuWebhook } from '../types';
import { computeIPaymuSignature } from './billing';

/**
 * Result from processing an iPaymu webhook.
 */
export interface WebhookProcessResult {
  /** HTTP status code to return */
  status: number;
  /** Response body */
  body: { success: boolean; message: string };
}

/**
 * iPaymu payment status codes that indicate success.
 */
const SUCCESS_STATUSES = ['1', 'berhasil', 'success'];

/**
 * iPaymu payment status codes that indicate failure or cancellation.
 */
const FAILED_STATUSES = ['0', '-1', 'gagal', 'failed', 'cancelled', 'expired'];

/**
 * Processes an iPaymu webhook callback with full signature validation and idempotency.
 *
 * Flow:
 * 1. Validate the HMAC signature BEFORE any state changes (Req 10.1)
 * 2. Reject with 401 if signature is invalid; log security alert (Req 10.4)
 * 3. Reject with 400 if trx_id (event_id) is missing/empty (Req 10.5)
 * 4. Check idempotency: if event already processed, return 200 (Req 10.3)
 * 5. Process payment:
 *    - Success: activate subscription or credit quota (Req 5.4, 5.5)
 *    - Failed/Cancelled: update transaction status only (Req 5.9)
 * 6. Record processed event in webhook_events table (Req 10.2)
 * 7. Return 200 OK
 *
 * Must respond within 5 seconds (Req 10.6).
 *
 * @param db - D1 database binding
 * @param secret - iPaymu shared secret for signature validation
 * @param body - Raw webhook body (the IPaymuWebhook payload)
 * @param sourceIp - Source IP address of the webhook request
 * @returns WebhookProcessResult with status code and response body
 */
export async function processIPaymuWebhook(
  db: D1Database,
  secret: string,
  body: IPaymuWebhook,
  sourceIp: string
): Promise<WebhookProcessResult> {
  const now = new Date().toISOString();

  // Step 1: Validate HMAC signature BEFORE any state changes (Req 10.1)
  // Compute expected signature from the body fields (excluding the signature field itself)
  const signaturePayload = buildSignaturePayload(body);
  const expectedSignature = await computeIPaymuSignature(signaturePayload, secret);

  if (!body.signature || body.signature !== expectedSignature) {
    // Step 2: Reject with 401 and log security alert (Req 10.4)
    await logSecurityAlert(db, {
      type: 'WEBHOOK_SIGNATURE_INVALID',
      detail: JSON.stringify({
        received_signature: body.signature || null,
        source_ip: sourceIp,
        trx_id: body.trx_id || null,
        timestamp: now,
      }),
      sourceIp,
      timestamp: now,
    });

    return {
      status: 401,
      body: { success: false, message: 'Invalid signature' },
    };
  }

  // Step 3: Reject with 400 if trx_id (event_id) is missing or empty (Req 10.5)
  if (!body.trx_id || body.trx_id.trim() === '') {
    await logSecurityAlert(db, {
      type: 'WEBHOOK_MISSING_EVENT_ID',
      detail: JSON.stringify({
        source_ip: sourceIp,
        timestamp: now,
        payload_keys: Object.keys(body),
      }),
      sourceIp,
      timestamp: now,
    });

    return {
      status: 400,
      body: { success: false, message: 'Missing or empty event ID (trx_id)' },
    };
  }

  const eventId = body.trx_id;

  // Step 4: Check idempotency - lookup event_id in webhook_events table (Req 10.3)
  const existingEvent = await db
    .prepare('SELECT id FROM webhook_events WHERE event_id = ?')
    .bind(eventId)
    .first<{ id: string }>();

  if (existingEvent) {
    // Duplicate webhook - return 200 without reprocessing
    return {
      status: 200,
      body: { success: true, message: 'Event already processed' },
    };
  }

  // Step 5: Process the payment based on status
  // reference_id maps to our transaction.id
  const transactionId = body.reference_id;

  if (!transactionId) {
    // No reference_id - cannot link to a transaction, but still record the event
    await recordWebhookEvent(db, eventId, null, body, now);
    return {
      status: 200,
      body: { success: true, message: 'Processed (no reference_id)' },
    };
  }

  // Look up the transaction to get tenant_id and type
  const transaction = await db
    .prepare(
      'SELECT id, tenant_id, type, plan_id, quota_amount, status FROM transactions WHERE id = ?'
    )
    .bind(transactionId)
    .first<{
      id: string;
      tenant_id: string;
      type: string;
      plan_id: string | null;
      quota_amount: number | null;
      status: string;
    }>();

  if (!transaction) {
    // Transaction not found - record event but cannot process
    await recordWebhookEvent(db, eventId, null, body, now);
    return {
      status: 200,
      body: { success: true, message: 'Processed (transaction not found)' },
    };
  }

  const tenantId = transaction.tenant_id;
  const statusCode = body.status_code?.toLowerCase() || body.status?.toLowerCase() || '';

  if (isSuccessStatus(statusCode)) {
    // Success payment: activate subscription or credit quota (Req 5.4, 5.5)
    await handleSuccessfulPayment(db, transaction, body, now);
  } else if (isFailedStatus(statusCode)) {
    // Failed/cancelled: update transaction status only, no tier/quota changes (Req 5.9)
    await handleFailedPayment(db, transaction, statusCode, now);
  } else {
    // Unknown status - update transaction with raw status
    await db
      .prepare(
        'UPDATE transactions SET status = ?, ipaymu_trx_id = ?, updated_at = ? WHERE id = ? AND tenant_id = ?'
      )
      .bind('pending', eventId, now, transactionId, tenantId)
      .run();
  }

  // Step 6: Record the processed event (Req 10.2)
  await recordWebhookEvent(db, eventId, tenantId, body, now);

  // Step 7: Return 200 OK
  return {
    status: 200,
    body: { success: true, message: 'Webhook processed successfully' },
  };
}

/**
 * Builds the string payload for signature computation.
 * The signature is computed over the concatenation of key fields (excluding the signature field).
 */
function buildSignaturePayload(body: IPaymuWebhook): string {
  // Use a deterministic string representation of the payload fields for HMAC computation
  // Exclude the signature field itself
  return JSON.stringify({
    trx_id: body.trx_id || '',
    status: body.status || '',
    status_code: body.status_code || '',
    sid: body.sid || '',
    amount: body.amount || 0,
    reference_id: body.reference_id || '',
  });
}

/**
 * Checks if the status code indicates a successful payment.
 */
function isSuccessStatus(statusCode: string): boolean {
  return SUCCESS_STATUSES.includes(statusCode);
}

/**
 * Checks if the status code indicates a failed or cancelled payment.
 */
function isFailedStatus(statusCode: string): boolean {
  return FAILED_STATUSES.includes(statusCode);
}

/**
 * Handles a successful payment by activating subscription or crediting quota.
 * Requirements: 5.4, 5.5
 */
async function handleSuccessfulPayment(
  db: D1Database,
  transaction: {
    id: string;
    tenant_id: string;
    type: string;
    plan_id: string | null;
    quota_amount: number | null;
    status: string;
  },
  webhookBody: IPaymuWebhook,
  now: string
): Promise<void> {
  const { id: transactionId, tenant_id: tenantId, type, plan_id, quota_amount } = transaction;

  // Update transaction status to 'success'
  await db
    .prepare(
      'UPDATE transactions SET status = ?, ipaymu_trx_id = ?, updated_at = ? WHERE id = ? AND tenant_id = ?'
    )
    .bind('success', webhookBody.trx_id, now, transactionId, tenantId)
    .run();

  if (type === 'subscription_upgrade' && plan_id) {
    // Activate new subscription tier (Req 5.4)
    await db
      .prepare('UPDATE tenants SET plan_tier = ?, updated_at = ? WHERE id = ?')
      .bind(plan_id, now, tenantId)
      .run();
  } else if (type === 'quota_purchase' && quota_amount && quota_amount > 0) {
    // Credit broadcast quota (Req 5.5)
    await db
      .prepare('UPDATE tenants SET broadcast_quota = broadcast_quota + ?, updated_at = ? WHERE id = ?')
      .bind(quota_amount, now, tenantId)
      .run();
  }
}

/**
 * Handles a failed/cancelled payment by updating transaction status only.
 * No tier or quota changes are made (Req 5.9).
 */
async function handleFailedPayment(
  db: D1Database,
  transaction: {
    id: string;
    tenant_id: string;
    type: string;
    plan_id: string | null;
    quota_amount: number | null;
    status: string;
  },
  statusCode: string,
  now: string
): Promise<void> {
  // Map the status code to our internal status
  const internalStatus = statusCode === 'cancelled' ? 'cancelled' : 'failed';

  await db
    .prepare(
      'UPDATE transactions SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?'
    )
    .bind(internalStatus, now, transaction.id, transaction.tenant_id)
    .run();
}

/**
 * Records a processed webhook event in the webhook_events table for idempotency (Req 10.2).
 * Events are retained for at least 90 days (enforced at DB/cleanup level).
 */
async function recordWebhookEvent(
  db: D1Database,
  eventId: string,
  tenantId: string | null,
  body: IPaymuWebhook,
  now: string
): Promise<void> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO webhook_events (id, event_id, tenant_id, source, payload, processed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, eventId, tenantId, 'ipaymu', JSON.stringify(body), now, now)
    .run();
}

/**
 * Logs a security alert to the admin_alerts table (Req 10.4, 10.5).
 */
async function logSecurityAlert(
  db: D1Database,
  alert: {
    type: string;
    detail: string;
    sourceIp: string;
    timestamp: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admin_alerts (id, type, detail, source_ip, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(crypto.randomUUID(), alert.type, alert.detail, alert.sourceIp, alert.timestamp)
    .run();
}
