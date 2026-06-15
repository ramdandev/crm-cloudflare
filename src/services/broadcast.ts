/**
 * Broadcast Service for Meta Cloud API integration.
 * Handles broadcast initiation with quota validation and queue enqueuing.
 *
 * Requirements: 4.1, 4.5, 4.6
 */

import type { BroadcastRequest, BroadcastResult, QueueMessage } from '../types';

/** Minimum number of contacts in a broadcast */
const MIN_CONTACTS = 1;

/** Maximum number of contacts in a broadcast */
const MAX_CONTACTS = 10_000;

/** Maximum retry attempts for queue messages */
const MAX_RETRIES = 5;

/**
 * Error thrown when a tenant has insufficient broadcast quota.
 * Route handlers should catch this and return 402 Payment Required.
 */
export class InsufficientQuotaError extends Error {
  constructor(required: number, available: number) {
    super(
      `Insufficient broadcast quota: required ${required}, available ${available}. Purchase additional quota to proceed.`
    );
    this.name = 'InsufficientQuotaError';
  }
}

/**
 * Error thrown when the contact list size is invalid.
 * Route handlers should catch this and return 400 Bad Request.
 */
export class InvalidContactListError extends Error {
  constructor(count: number) {
    super(
      `Invalid contact list size: ${count}. Must be between ${MIN_CONTACTS} and ${MAX_CONTACTS} contacts.`
    );
    this.name = 'InvalidContactListError';
  }
}

/**
 * BroadcastService provides methods for initiating broadcasts,
 * validating quota, and enqueuing messages to Cloudflare Queues.
 */
export class BroadcastService {
  private db: D1Database;
  private queue: Queue;

  constructor(db: D1Database, queue: Queue) {
    this.db = db;
    this.queue = queue;
  }

  /**
   * Initiate a broadcast to a list of contacts.
   *
   * Steps:
   * 1. Validate contact_ids length is 1-10,000
   * 2. Check tenant's broadcast_quota >= contact_ids.length
   * 3. If insufficient: throw InsufficientQuotaError (route returns 402)
   * 4. Atomically deduct quota: UPDATE tenants SET broadcast_quota = broadcast_quota - ? WHERE id = ? AND broadcast_quota >= ?
   * 5. Create broadcast record in broadcasts table
   * 6. For each contact: look up phone_number, create broadcast_message record, enqueue QueueMessage
   * 7. Return BroadcastResult with broadcast_id, total_messages, status='queued'
   *
   * @param tenantId - The tenant initiating the broadcast
   * @param request - The broadcast request with template and contact IDs
   * @returns BroadcastResult with broadcast_id and status
   * @throws InsufficientQuotaError if tenant doesn't have enough quota
   * @throws InvalidContactListError if contact list size is invalid
   */
  async initiateBroadcast(tenantId: string, request: BroadcastRequest): Promise<BroadcastResult> {
    const contactCount = request.contact_ids.length;

    // Step 1: Validate contact list size (1-10,000)
    if (contactCount < MIN_CONTACTS || contactCount > MAX_CONTACTS) {
      throw new InvalidContactListError(contactCount);
    }

    // Step 2: Check tenant's broadcast_quota
    const tenant = await this.db
      .prepare('SELECT broadcast_quota FROM tenants WHERE id = ?')
      .bind(tenantId)
      .first<{ broadcast_quota: number }>();

    if (!tenant) {
      throw new Error('Tenant not found');
    }

    if (tenant.broadcast_quota < contactCount) {
      throw new InsufficientQuotaError(contactCount, tenant.broadcast_quota);
    }

    // Step 4: Atomically deduct quota
    // This uses a WHERE clause to ensure the quota hasn't been reduced
    // by a concurrent request between the check and the deduction.
    const deductResult = await this.db
      .prepare(
        'UPDATE tenants SET broadcast_quota = broadcast_quota - ?, updated_at = ? WHERE id = ? AND broadcast_quota >= ?'
      )
      .bind(contactCount, new Date().toISOString(), tenantId, contactCount)
      .run();

    if ((deductResult.meta?.changes ?? 0) === 0) {
      // Concurrent request may have reduced quota - re-check
      const refreshedTenant = await this.db
        .prepare('SELECT broadcast_quota FROM tenants WHERE id = ?')
        .bind(tenantId)
        .first<{ broadcast_quota: number }>();

      throw new InsufficientQuotaError(
        contactCount,
        refreshedTenant?.broadcast_quota ?? 0
      );
    }

    // Step 5: Create broadcast record
    const broadcastId = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `INSERT INTO broadcasts (id, tenant_id, template_name, template_language, total_messages, sent_count, failed_count, status, created_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, 'queued', ?)`
      )
      .bind(
        broadcastId,
        tenantId,
        request.template_name,
        request.template_language,
        contactCount,
        now
      )
      .run();

    // Step 6: Look up contacts, create broadcast_message records, enqueue messages
    // Fetch all contacts' phone numbers in one query
    const placeholders = request.contact_ids.map(() => '?').join(',');
    const contacts = await this.db
      .prepare(
        `SELECT id, phone_number FROM contacts WHERE id IN (${placeholders}) AND tenant_id = ?`
      )
      .bind(...request.contact_ids, tenantId)
      .all<{ id: string; phone_number: string | null }>();

    const contactMap = new Map<string, string | null>();
    for (const contact of contacts.results ?? []) {
      contactMap.set(contact.id, contact.phone_number);
    }

    // Prepare queue messages in batches for efficiency
    const queueMessages: { body: QueueMessage }[] = [];

    for (let i = 0; i < request.contact_ids.length; i++) {
      const contactId = request.contact_ids[i]!;
      const phoneNumber = contactMap.get(contactId);

      // Skip contacts without phone numbers (they can't receive WhatsApp messages)
      if (!phoneNumber) {
        continue;
      }

      const messageId = crypto.randomUUID();

      // Create broadcast_message record in D1
      await this.db
        .prepare(
          `INSERT INTO broadcast_messages (id, broadcast_id, tenant_id, contact_id, phone_number, delivery_status, retry_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)`
        )
        .bind(messageId, broadcastId, tenantId, contactId, phoneNumber, now, now)
        .run();

      // Prepare queue message
      const templateParams = request.template_params?.[i] ?? undefined;
      const queueMessage: QueueMessage = {
        broadcast_id: broadcastId,
        tenant_id: tenantId,
        contact_phone: phoneNumber,
        template_name: request.template_name,
        template_language: request.template_language,
        template_params: templateParams,
        retry_count: 0,
        max_retries: MAX_RETRIES,
      };

      queueMessages.push({ body: queueMessage });
    }

    // Enqueue messages using sendBatch for efficiency
    // Cloudflare Queues sendBatch has a limit, so we batch in groups
    const BATCH_SIZE = 100;
    for (let i = 0; i < queueMessages.length; i += BATCH_SIZE) {
      const batch = queueMessages.slice(i, i + BATCH_SIZE);
      await this.queue.sendBatch(batch);
    }

    // Step 7: Return result
    return {
      broadcast_id: broadcastId,
      total_messages: queueMessages.length,
      status: 'queued',
    };
  }

  /**
   * Check the current broadcast quota for a tenant.
   *
   * @param tenantId - The tenant to check quota for
   * @returns The current broadcast_quota value
   */
  async checkQuota(tenantId: string): Promise<number> {
    const result = await this.db
      .prepare('SELECT broadcast_quota FROM tenants WHERE id = ?')
      .bind(tenantId)
      .first<{ broadcast_quota: number }>();

    if (!result) {
      throw new Error('Tenant not found');
    }

    return result.broadcast_quota;
  }
}

// ============================================================================
// Standalone function wrappers for route consumption
// ============================================================================

/**
 * Initiate a broadcast for a tenant.
 */
export async function initiateBroadcast(
  db: D1Database,
  queue: Queue,
  tenantId: string,
  request: BroadcastRequest
): Promise<BroadcastResult> {
  const service = new BroadcastService(db, queue);
  return service.initiateBroadcast(tenantId, request);
}

/**
 * Check broadcast quota for a tenant.
 */
export async function checkBroadcastQuota(
  db: D1Database,
  tenantId: string
): Promise<number> {
  const service = new BroadcastService(db, null as unknown as Queue);
  return service.checkQuota(tenantId);
}
