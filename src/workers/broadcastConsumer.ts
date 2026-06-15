/**
 * Broadcast Queue Consumer for Meta Cloud API integration.
 * Processes broadcast messages from Cloudflare Queues and sends them
 * via the WhatsApp Business Platform (Meta Cloud API).
 *
 * Requirements: 4.2, 4.3, 4.4, 4.7, 4.8
 *
 * Behavior:
 * - Processes batch of messages (max 10 per batch) from Cloudflare Queues
 * - Sends each message to Meta Cloud API (POST /v18.0/{PHONE_NUMBER_ID}/messages)
 * - On success (200): updates broadcast_message status to "delivered", acks the message
 * - On rate-limit (429): re-enqueues with exponential backoff, retries up to max_retries
 * - On permanent failure (4xx except 429): marks as "failed", acks the message
 * - After max retries exceeded: marks as "failed", acks the message
 * - Backoff formula: Math.min(300, Math.pow(2, retryCount)) seconds
 */

import type { Bindings } from '../types';
import type { QueueMessage } from '../types';

/**
 * Meta Cloud API base URL for WhatsApp Business Platform.
 */
const META_API_BASE = 'https://graph.facebook.com/v18.0';

/**
 * Maximum backoff delay in seconds for rate-limited retries.
 */
const MAX_BACKOFF_SECONDS = 300;

/**
 * Calculate exponential backoff delay in seconds.
 * Formula: Math.min(300, Math.pow(2, retryCount))
 *
 * @param retryCount - The current retry count (0-indexed)
 * @returns Delay in seconds before next retry
 */
export function calculateBackoff(retryCount: number): number {
  return Math.min(MAX_BACKOFF_SECONDS, Math.pow(2, retryCount));
}

/**
 * Build the Meta Cloud API request body for a WhatsApp template message.
 *
 * @param phone - Recipient phone number in E.164 format
 * @param templateName - WhatsApp template name
 * @param templateLanguage - Template language code (e.g., "en", "id")
 * @param templateParams - Optional template parameters
 * @returns The JSON body for the Meta Cloud API request
 */
export function buildMetaApiBody(
  phone: string,
  templateName: string,
  templateLanguage: string,
  templateParams?: Record<string, string>
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: {
        code: templateLanguage,
      },
      ...(templateParams && Object.keys(templateParams).length > 0
        ? {
            components: [
              {
                type: 'body',
                parameters: Object.values(templateParams).map((value) => ({
                  type: 'text',
                  text: value,
                })),
              },
            ],
          }
        : {}),
    },
  };

  return body;
}

/**
 * Send a single WhatsApp template message via Meta Cloud API.
 *
 * @param phone - Recipient phone number
 * @param templateName - Template name
 * @param templateLanguage - Template language code
 * @param templateParams - Optional template parameters
 * @param env - Cloudflare Worker bindings containing META_ACCESS_TOKEN and META_PHONE_NUMBER_ID
 * @returns The fetch Response from Meta Cloud API
 */
async function sendMetaMessage(
  phone: string,
  templateName: string,
  templateLanguage: string,
  templateParams: Record<string, string> | undefined,
  env: Bindings
): Promise<Response> {
  const url = `${META_API_BASE}/${env.META_PHONE_NUMBER_ID}/messages`;
  const body = buildMetaApiBody(phone, templateName, templateLanguage, templateParams);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.META_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  return response;
}

/**
 * Update the delivery status of a broadcast message in D1.
 *
 * @param db - D1 database binding
 * @param broadcastId - The broadcast this message belongs to
 * @param tenantId - The tenant ID for scoping
 * @param phone - The recipient phone number (used as identifier with broadcast_id)
 * @param status - The new delivery status
 * @param errorDetail - Optional error detail for failed messages
 */
async function updateBroadcastMessageStatus(
  db: D1Database,
  broadcastId: string,
  tenantId: string,
  phone: string,
  status: 'delivered' | 'failed',
  errorDetail?: string
): Promise<void> {
  const now = new Date().toISOString();

  if (errorDetail) {
    await db
      .prepare(
        `UPDATE broadcast_messages 
         SET delivery_status = ?, error_detail = ?, updated_at = ? 
         WHERE broadcast_id = ? AND tenant_id = ? AND phone_number = ? AND delivery_status != 'delivered'`
      )
      .bind(status, errorDetail, now, broadcastId, tenantId, phone)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE broadcast_messages 
         SET delivery_status = ?, updated_at = ? 
         WHERE broadcast_id = ? AND tenant_id = ? AND phone_number = ? AND delivery_status != 'delivered'`
      )
      .bind(status, now, broadcastId, tenantId, phone)
      .run();
  }

  // Update broadcast aggregate counts
  if (status === 'delivered') {
    await db
      .prepare(
        `UPDATE broadcasts 
         SET sent_count = sent_count + 1, status = 'in_progress' 
         WHERE id = ? AND tenant_id = ?`
      )
      .bind(broadcastId, tenantId)
      .run();
  } else if (status === 'failed') {
    await db
      .prepare(
        `UPDATE broadcasts 
         SET failed_count = failed_count + 1, status = 'in_progress' 
         WHERE id = ? AND tenant_id = ?`
      )
      .bind(broadcastId, tenantId)
      .run();
  }
}

/**
 * Determine if an HTTP status code represents a permanent failure.
 * Permanent failures are 4xx errors except 429 (rate limit).
 *
 * @param statusCode - The HTTP response status code
 * @returns true if this is a permanent failure that should not be retried
 */
export function isPermanentFailure(statusCode: number): boolean {
  return statusCode >= 400 && statusCode < 500 && statusCode !== 429;
}

/**
 * Determine if an HTTP status code represents a rate-limit error.
 *
 * @param statusCode - The HTTP response status code
 * @returns true if this is a rate-limit error that should trigger retry with backoff
 */
export function isRateLimitError(statusCode: number): boolean {
  return statusCode === 429;
}

/**
 * Process a single queue message from the broadcast queue.
 * Handles sending via Meta Cloud API and updating statuses.
 *
 * @param msg - The Cloudflare Queue message object
 * @param env - Cloudflare Worker bindings
 */
async function processMessage(
  msg: Message<QueueMessage>,
  env: Bindings
): Promise<void> {
  const payload = msg.body;
  const { broadcast_id, tenant_id, contact_phone, template_name, template_language, template_params, retry_count, max_retries } = payload;

  // Check if max retries exceeded before attempting send
  if (retry_count >= max_retries) {
    await updateBroadcastMessageStatus(
      env.DB,
      broadcast_id,
      tenant_id,
      contact_phone,
      'failed',
      `Max retries exceeded (${max_retries})`
    );
    msg.ack();
    return;
  }

  try {
    const response = await sendMetaMessage(
      contact_phone,
      template_name,
      template_language,
      template_params,
      env
    );

    if (response.ok) {
      // Success: update status to "delivered" and ack
      await updateBroadcastMessageStatus(
        env.DB,
        broadcast_id,
        tenant_id,
        contact_phone,
        'delivered'
      );
      msg.ack();
    } else if (isRateLimitError(response.status)) {
      // Rate limited: re-enqueue with exponential backoff
      const delaySeconds = calculateBackoff(retry_count);
      msg.retry({ delaySeconds });
    } else if (isPermanentFailure(response.status)) {
      // Permanent failure (4xx except 429): mark as failed, do not retry
      let errorDetail = `HTTP ${response.status}`;
      try {
        const errorBody = await response.text();
        errorDetail = `HTTP ${response.status}: ${errorBody.substring(0, 500)}`;
      } catch {
        // If we can't read the body, use status code only
      }

      await updateBroadcastMessageStatus(
        env.DB,
        broadcast_id,
        tenant_id,
        contact_phone,
        'failed',
        errorDetail
      );
      msg.ack();
    } else {
      // Server error (5xx) or other transient error: retry with backoff
      const delaySeconds = calculateBackoff(retry_count);
      msg.retry({ delaySeconds });
    }
  } catch (error) {
    // Network error or unexpected exception: retry with backoff
    const delaySeconds = calculateBackoff(retry_count);
    msg.retry({ delaySeconds });
  }
}

/**
 * Cloudflare Queue consumer handler for broadcast messages.
 * Processes a batch of messages (max 10 per batch) from BROADCAST_QUEUE.
 *
 * Each message is sent to the Meta Cloud API, and the delivery status
 * is updated in D1 based on the API response.
 *
 * Rate control: Cloudflare Queues handles batching (max 10 per batch).
 * The 80 msg/s per tenant rate is naturally enforced by queue configuration
 * (max_batch_size and max_concurrency in wrangler.toml).
 *
 * @param batch - The MessageBatch from Cloudflare Queues
 * @param env - Cloudflare Worker environment bindings
 */
export async function handleBroadcastQueue(
  batch: MessageBatch<QueueMessage>,
  env: Bindings
): Promise<void> {
  // Process each message in the batch sequentially to respect rate limits
  for (const msg of batch.messages) {
    await processMessage(msg, env);
  }
}
