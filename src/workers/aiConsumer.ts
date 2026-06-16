/**
 * AI Queue Consumer for processing AI pipeline jobs.
 * Consumes AIProcessingJob messages from the AI_QUEUE and invokes
 * the AI pipeline for message processing.
 *
 * Requirements: 3.1
 *
 * Behavior:
 * - Processes messages sequentially to respect AI provider rate limits
 * - On success: acks the message
 * - On error with retries < 3: retries with exponential backoff
 * - On error with retries >= 3: acks the message (dead letter) and logs the failure
 * - Backoff formula: Math.min(60, Math.pow(2, retryCount)) seconds
 */

import type { AIProcessingJob } from '../types/ai';
import type { Bindings } from '../types/bindings';
import { processAIMessage } from '../services/ai/pipeline';

/**
 * Maximum number of retries before dead-lettering a message.
 */
const MAX_RETRIES = 3;

/**
 * Maximum backoff delay in seconds.
 */
const MAX_BACKOFF_SECONDS = 60;

/**
 * Calculate exponential backoff delay in seconds.
 * Formula: Math.min(60, Math.pow(2, retryCount))
 *
 * @param retryCount - The current retry attempt (0-indexed)
 * @returns Delay in seconds before next retry
 */
export function calculateBackoff(retryCount: number): number {
  return Math.min(MAX_BACKOFF_SECONDS, Math.pow(2, retryCount));
}

/**
 * Cloudflare Queue consumer handler for AI processing jobs.
 * Processes a batch of AIProcessingJob messages from AI_QUEUE sequentially
 * to respect AI provider rate limits.
 *
 * For each message:
 * - Calls processAIMessage with the job payload and environment bindings
 * - On success: acknowledges the message
 * - On error: retries with exponential backoff up to MAX_RETRIES,
 *   then dead-letters (acks) the message and logs the failure
 *
 * @param batch - The MessageBatch from Cloudflare Queues containing AIProcessingJob payloads
 * @param env - Cloudflare Worker environment bindings
 */
export async function handleAIQueue(
  batch: MessageBatch<AIProcessingJob>,
  env: Bindings
): Promise<void> {
  // Process messages sequentially to respect AI provider rate limits
  for (const msg of batch.messages) {
    try {
      await processAIMessage(msg.body, env);
      msg.ack();
    } catch (error) {
      const retryCount = msg.attempts ?? 0;

      if (retryCount < MAX_RETRIES) {
        // Retry with exponential backoff
        const delaySeconds = calculateBackoff(retryCount);
        msg.retry({ delaySeconds });
      } else {
        // Dead letter: max retries exceeded, ack to remove from queue
        console.error(
          `[AI Queue] Dead letter - message for tenant=${msg.body.tenant_id} contact=${msg.body.contact_id} message=${msg.body.message_id} failed after ${MAX_RETRIES} retries:`,
          error instanceof Error ? error.message : String(error)
        );
        msg.ack();
      }
    }
  }
}
