/**
 * Audit Service for message status transition logging.
 * Tracks every delivery_status change in the message_status_log table
 * for compliance and audit trail purposes.
 *
 * Requirements: 8.1, 8.2
 *
 * Usage:
 * - Call `logStatusTransition` whenever a message's delivery_status changes
 * - Integrates with Go-Wa service (operational messages) and broadcast consumer (broadcast messages)
 * - Records previous_status, new_status, and changed_at timestamp for every transition
 */

import type { DeliveryStatus } from '../types';

/**
 * Logs a message delivery status transition into the message_status_log table.
 *
 * This function should be called every time a message's delivery_status changes,
 * including:
 * - When a message is first created (previousStatus = null, newStatus = initial status)
 * - When a Go-Wa message transitions from 'sent' to 'delivered', 'read', or 'failed'
 * - When a broadcast message transitions from 'queued' to 'sent', 'delivered', or 'failed'
 *
 * @param db - D1 database binding
 * @param messageId - The ID of the message whose status changed
 * @param tenantId - The tenant ID for data scoping (Requirement 9.1)
 * @param previousStatus - The status before the transition (null for initial creation)
 * @param newStatus - The new status after the transition
 * @returns The ID of the created status log entry
 */
export async function logStatusTransition(
  db: D1Database,
  messageId: string,
  tenantId: string,
  previousStatus: DeliveryStatus | null,
  newStatus: DeliveryStatus
): Promise<string> {
  const id = crypto.randomUUID();
  const changedAt = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO message_status_log (id, message_id, tenant_id, previous_status, new_status, changed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, messageId, tenantId, previousStatus, newStatus, changedAt)
    .run();

  return id;
}

/**
 * Updates a message's delivery status in the messages table and logs the transition.
 * This is a convenience function that combines the status update and audit logging
 * in a single call, ensuring the audit trail is always maintained.
 *
 * Use this function from Go-Wa service and broadcast consumer when updating
 * message statuses to ensure consistent audit logging.
 *
 * @param db - D1 database binding
 * @param messageId - The ID of the message to update
 * @param tenantId - The tenant ID for data scoping
 * @param previousStatus - The current/previous delivery status
 * @param newStatus - The new delivery status to set
 * @returns The ID of the created status log entry
 */
export async function updateMessageStatusWithAudit(
  db: D1Database,
  messageId: string,
  tenantId: string,
  previousStatus: DeliveryStatus | null,
  newStatus: DeliveryStatus
): Promise<string> {
  const now = new Date().toISOString();

  // Update the message's delivery_status in the messages table
  await db
    .prepare(
      `UPDATE messages SET delivery_status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`
    )
    .bind(newStatus, now, messageId, tenantId)
    .run();

  // Log the status transition in the audit table
  return logStatusTransition(db, messageId, tenantId, previousStatus, newStatus);
}

/**
 * Updates a broadcast message's delivery status and logs the transition.
 * Similar to updateMessageStatusWithAudit but operates on the broadcast_messages table.
 *
 * Use this function from the broadcast consumer when broadcast message statuses change.
 *
 * @param db - D1 database binding
 * @param broadcastMessageId - The ID of the broadcast_message record
 * @param tenantId - The tenant ID for data scoping
 * @param previousStatus - The current/previous delivery status
 * @param newStatus - The new delivery status to set
 * @param errorDetail - Optional error detail for failed messages
 * @returns The ID of the created status log entry
 */
export async function updateBroadcastMessageStatusWithAudit(
  db: D1Database,
  broadcastMessageId: string,
  tenantId: string,
  previousStatus: DeliveryStatus | null,
  newStatus: DeliveryStatus,
  errorDetail?: string
): Promise<string> {
  const now = new Date().toISOString();

  // Update the broadcast_message's delivery_status
  if (errorDetail) {
    await db
      .prepare(
        `UPDATE broadcast_messages SET delivery_status = ?, error_detail = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`
      )
      .bind(newStatus, errorDetail, now, broadcastMessageId, tenantId)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE broadcast_messages SET delivery_status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`
      )
      .bind(newStatus, now, broadcastMessageId, tenantId)
      .run();
  }

  // Log the status transition in the audit table
  return logStatusTransition(db, broadcastMessageId, tenantId, previousStatus, newStatus);
}
