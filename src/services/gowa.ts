/**
 * Go-Wa Messaging Service for sending WhatsApp messages
 * via the Go-Wa (aldinokemal) gateway.
 *
 * Handles:
 * - Sending outbound messages with 10-second timeout
 * - Storing messages in D1 with full metadata (sender, recipient, timestamp, type, delivery_status, channel)
 * - Contact linking by phone number
 * - Timeout detection and failure logging
 *
 * Requirements: 3.1, 3.4, 3.5
 */

import type { GoWaMessage, GoWaWebhookPayload, GoWaMediaPayload, MessageType } from '../types';

/** Timeout for Go-Wa API requests: 10 seconds */
const GOWA_TIMEOUT_MS = 10_000;

/** Maximum media file size: 16 MB */
const MAX_MEDIA_SIZE = 16 * 1024 * 1024;

/** Go-Wa send message endpoint path (aldinokemal format) */
const GOWA_SEND_ENDPOINT = '/send/message';

/**
 * Result of a sendMessage operation.
 * On success, returns the message record.
 * On failure, returns error details along with the message record (status='failed').
 */
export type SendMessageResult =
  | { success: true; message: GoWaMessage }
  | { success: false; error: string; message: GoWaMessage };

/**
 * GoWaService provides messaging operations via the Go-Wa gateway.
 * All operations are tenant-scoped and messages are persisted in D1.
 */
export class GoWaService {
  private db: D1Database;
  private gowaBaseUrl: string;
  private gowaApiKey: string;

  constructor(db: D1Database, gowaBaseUrl: string, gowaApiKey: string) {
    this.db = db;
    this.gowaBaseUrl = gowaBaseUrl;
    this.gowaApiKey = gowaApiKey;
  }

  /**
   * Send a message to a recipient via the Go-Wa gateway.
   *
   * Flow:
   * 1. Look up contact_id by phone number match within the tenant
   * 2. Create message record in D1 with status='sent', channel='gowa'
   * 3. POST to Go-Wa gateway (`{GOWA_BASE_URL}/send/message`) with 10-second timeout (AbortController)
   * 4. On success: return the message record
   * 5. On timeout/error: set delivery_status to 'failed', log the event, return error
   *
   * Go-Wa API format (aldinokemal): POST `/send/message` with body `{ phone: string, message: string }`
   *
   * @param tenantId - The tenant initiating the message
   * @param recipient - The recipient phone number
   * @param content - The message content/body
   * @param type - The message type (default: 'text')
   * @returns SendMessageResult indicating success or failure with message record
   */
  async sendMessage(
    tenantId: string,
    recipient: string,
    content: string,
    type: MessageType = 'text'
  ): Promise<SendMessageResult> {
    // Step 1: Look up contact by phone number within the tenant
    const contactId = await this.findContactByPhone(tenantId, recipient);

    // Step 2: Create message record in D1 with initial status 'sent'
    const messageId = crypto.randomUUID();
    const now = new Date().toISOString();

    const message: GoWaMessage = {
      id: messageId,
      tenant_id: tenantId,
      contact_id: contactId,
      sender: 'system',
      recipient,
      message_type: type,
      content,
      media_url: null,
      delivery_status: 'sent',
      channel: 'gowa',
      created_at: now,
      updated_at: now,
    };

    // Store outbound message in D1
    await this.db
      .prepare(
        `INSERT INTO messages (id, tenant_id, contact_id, sender, recipient, message_type, content, media_url, delivery_status, channel, sender_phone, is_unlinked, oversized_media, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        message.id,
        message.tenant_id,
        message.contact_id,
        message.sender,
        message.recipient,
        message.message_type,
        message.content,
        message.media_url,
        message.delivery_status,
        message.channel,
        null, // sender_phone not needed for outbound
        0,    // is_unlinked: not applicable for outbound
        0,    // oversized_media: not applicable for outbound
        message.created_at,
        message.updated_at
      )
      .run();

    // Step 3: POST to Go-Wa gateway with 10-second timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GOWA_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.gowaBaseUrl}${GOWA_SEND_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.gowaApiKey}`,
        },
        body: JSON.stringify({
          phone: recipient,
          message: content,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // Non-2xx response from Go-Wa gateway - mark as failed
        const errorMsg = `Go-Wa API returned status ${response.status}`;
        const failedMessage = await this.markMessageFailed(messageId, tenantId, errorMsg);
        return { success: false, error: errorMsg, message: failedMessage };
      }

      // Step 4: Success - return the message record with status='sent'
      return { success: true, message };
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      // Step 5: Determine if this was a timeout (AbortError) or other network error
      const isTimeout =
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('abort'));

      const errorMessage = isTimeout
        ? 'Go-Wa gateway timeout after 10 seconds'
        : `Go-Wa gateway error: ${error instanceof Error ? error.message : 'Unknown error'}`;

      // Mark message as failed and log the event
      const failedMessage = await this.markMessageFailed(messageId, tenantId, errorMessage);

      return { success: false, error: errorMessage, message: failedMessage };
    }
  }

  /**
   * Find a contact_id by phone number within a tenant.
   * Uses the contacts table index on (tenant_id, phone_number).
   *
   * @returns The contact ID if found, null otherwise
   */
  private async findContactByPhone(
    tenantId: string,
    phoneNumber: string
  ): Promise<string | null> {
    const result = await this.db
      .prepare('SELECT id FROM contacts WHERE tenant_id = ? AND phone_number = ?')
      .bind(tenantId, phoneNumber)
      .first<{ id: string }>();

    return result?.id ?? null;
  }

  /**
   * Mark a message as failed in D1 and log the failure event.
   * Updates delivery_status to 'failed' and inserts an admin_alert record.
   *
   * @param messageId - The message to mark as failed
   * @param tenantId - The tenant owning the message
   * @param reason - The failure reason for logging
   * @returns The updated message record
   */
  private async markMessageFailed(
    messageId: string,
    tenantId: string,
    reason: string
  ): Promise<GoWaMessage> {
    const now = new Date().toISOString();

    // Update message status to 'failed'
    await this.db
      .prepare(
        `UPDATE messages SET delivery_status = 'failed', updated_at = ? WHERE id = ? AND tenant_id = ?`
      )
      .bind(now, messageId, tenantId)
      .run();

    // Log the failure event in admin_alerts for operational visibility
    await this.db
      .prepare(
        `INSERT INTO admin_alerts (type, detail, created_at) VALUES (?, ?, ?)`
      )
      .bind(
        'GOWA_SEND_FAILURE',
        JSON.stringify({ message_id: messageId, tenant_id: tenantId, reason }),
        now
      )
      .run();

    // Fetch and return the updated message record
    const updated = await this.db
      .prepare(
        `SELECT id, tenant_id, contact_id, sender, recipient, message_type, content, media_url, delivery_status, channel, created_at, updated_at
         FROM messages WHERE id = ? AND tenant_id = ?`
      )
      .bind(messageId, tenantId)
      .first<GoWaMessage>();

    // Fallback in case the fetch fails (shouldn't happen in practice)
    if (!updated) {
      return {
        id: messageId,
        tenant_id: tenantId,
        contact_id: null,
        sender: 'system',
        recipient: '',
        message_type: 'text',
        content: '',
        media_url: null,
        delivery_status: 'failed',
        channel: 'gowa',
        created_at: now,
        updated_at: now,
      };
    }

    return updated;
  }
}

// ============================================================================
// Standalone function wrapper for route consumption
// ============================================================================

/**
 * Send a message via Go-Wa gateway.
 * Convenience wrapper around GoWaService.sendMessage for use in route handlers.
 */
export async function sendGoWaMessage(
  db: D1Database,
  gowaBaseUrl: string,
  gowaApiKey: string,
  tenantId: string,
  recipient: string,
  content: string,
  type: MessageType = 'text'
): Promise<SendMessageResult> {
  const service = new GoWaService(db, gowaBaseUrl, gowaApiKey);
  return service.sendMessage(tenantId, recipient, content, type);
}



// ============================================================================
// Incoming Message Handler (Task 6.2)
// ============================================================================

/**
 * Handles an incoming WhatsApp message received via Go-Wa webhook.
 *
 * Logic:
 * 1. Look up contact by phone number within the tenant
 * 2. If found: link contact_id, set is_unlinked=0
 * 3. If NOT found: set contact_id=null, is_unlinked=1, store sender_phone
 * 4. If media present:
 *    - If media_size <= 16MB: download from Go-Wa, upload to R2, store reference
 *    - If media_size > 16MB: set oversized_media=1, don't store media
 * 5. Store message in D1 messages table with channel='gowa'
 *
 * Requirements: 3.2, 3.3, 3.6, 3.7
 *
 * @param tenantId - The tenant that owns this phone number/session
 * @param payload - The incoming webhook payload from Go-Wa
 * @param db - D1 database binding
 * @param r2 - R2 storage bucket binding
 * @returns The stored message record
 */
export async function handleIncomingMessage(
  tenantId: string,
  payload: GoWaWebhookPayload,
  db: D1Database,
  r2: R2Bucket
): Promise<GoWaMessage> {
  const messageId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Step 1: Look up contact by phone number within the tenant
  const contact = await db
    .prepare('SELECT id FROM contacts WHERE tenant_id = ? AND phone_number = ?')
    .bind(tenantId, payload.from)
    .first<{ id: string }>();

  const contactId = contact?.id ?? null;
  const isUnlinked = contact ? 0 : 1;
  const senderPhone = contact ? null : payload.from;

  // Step 2: Determine message type
  const messageType = normalizeMessageType(payload.type);

  // Step 3: Handle media if present
  let mediaUrl: string | null = null;
  let oversizedMedia = 0;

  if (payload.media_url) {
    if (payload.media_size && payload.media_size > MAX_MEDIA_SIZE) {
      // Media exceeds 16MB - flag as oversized, don't store media
      oversizedMedia = 1;
    } else {
      // Media is within size limit - download and upload to R2
      const mediaPayload: GoWaMediaPayload = {
        media_url: payload.media_url,
        media_size: payload.media_size || 0,
        content_type: getContentTypeFromMessageType(messageType),
        filename: generateMediaFilename(messageType, messageId),
        message_id: messageId,
      };

      const r2Key = await handleMediaMessage(tenantId, mediaPayload, r2);
      if (r2Key) {
        mediaUrl = r2Key;
      }
    }
  }

  // Step 4: Store message in D1
  await db
    .prepare(
      `INSERT INTO messages (
        id, tenant_id, contact_id, sender, recipient, message_type, content,
        media_url, delivery_status, channel, sender_phone, is_unlinked, oversized_media,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      messageId,
      tenantId,
      contactId,
      payload.from,       // sender is the customer
      tenantId,           // recipient is the tenant (agent)
      messageType,
      payload.message,
      mediaUrl,
      'delivered',        // incoming messages are already delivered
      'gowa',
      senderPhone,
      isUnlinked,
      oversizedMedia,
      now,
      now
    )
    .run();

  return {
    id: messageId,
    tenant_id: tenantId,
    contact_id: contactId,
    sender: payload.from,
    recipient: tenantId,
    message_type: messageType,
    content: payload.message,
    media_url: mediaUrl,
    delivery_status: 'delivered',
    channel: 'gowa',
    created_at: now,
    updated_at: now,
  };
}

// ============================================================================
// Media Message Handler (Task 6.2)
// ============================================================================

/**
 * Handles media download from Go-Wa and upload to R2 under tenant namespace.
 *
 * R2 key pattern: {tenant_id}/media/whatsapp/{message_id}/{filename}
 *
 * Requirements: 3.3
 *
 * @param tenantId - The tenant namespace for R2 storage
 * @param payload - Media payload with URL, size, content type, and filename
 * @param r2 - R2 storage bucket binding
 * @returns The R2 key if upload succeeded, or null if failed
 */
export async function handleMediaMessage(
  tenantId: string,
  payload: GoWaMediaPayload,
  r2: R2Bucket
): Promise<string | null> {
  try {
    // Download media from Go-Wa gateway URL with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GOWA_TIMEOUT_MS);

    const response = await fetch(payload.media_url, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(
        `Failed to download media from Go-Wa: ${response.status} ${response.statusText}`
      );
      return null;
    }

    const mediaBody = await response.arrayBuffer();

    // Upload to R2 under tenant namespace
    const r2Key = `${tenantId}/media/whatsapp/${payload.message_id}/${payload.filename}`;

    await r2.put(r2Key, mediaBody, {
      httpMetadata: {
        contentType: payload.content_type,
      },
      customMetadata: {
        tenant_id: tenantId,
        message_id: payload.message_id,
        original_filename: payload.filename,
      },
    });

    return r2Key;
  } catch (error) {
    console.error('Failed to handle media message:', error);
    return null;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Normalizes the message type string from Go-Wa webhook to our enum.
 * Falls back to 'text' for unrecognized types.
 */
function normalizeMessageType(type: string): MessageType {
  const normalized = type.toLowerCase();
  const validTypes: MessageType[] = ['text', 'image', 'video', 'audio', 'document'];

  if (validTypes.includes(normalized as MessageType)) {
    return normalized as MessageType;
  }

  return 'text';
}

/**
 * Derives a content type from the message type for media storage.
 */
function getContentTypeFromMessageType(type: MessageType): string {
  switch (type) {
    case 'image':
      return 'image/jpeg';
    case 'video':
      return 'video/mp4';
    case 'audio':
      return 'audio/mpeg';
    case 'document':
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Generates a filename for media based on type and message ID.
 */
function generateMediaFilename(type: MessageType, messageId: string): string {
  const extensions: Record<MessageType, string> = {
    text: '.txt',
    image: '.jpg',
    video: '.mp4',
    audio: '.mp3',
    document: '.bin',
  };

  return `${messageId}${extensions[type] || '.bin'}`;
}
