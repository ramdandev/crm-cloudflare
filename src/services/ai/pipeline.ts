/**
 * AI Pipeline Service — Core Orchestrator.
 *
 * Processes an incoming WhatsApp message through the full AI pipeline:
 * 1. Get AI config
 * 2. Check human takeover
 * 3. Check message type (text only)
 * 4. Check token quota
 * 5. Load conversation context
 * 6. Search Knowledge Base
 * 7. Build prompt
 * 8. Call AI provider
 * 9. Extract response
 * 10. Send reply via GoWa
 * 11. Record token usage
 * 12. Store context (relies on messages table)
 *
 * Requirements: 3.1, 3.4, 3.5, 3.6, 4.1, 4.3
 */

import type {
  AIProcessingJob,
  AIAgentConfig,
  ChatCompletionMessage,
  ChatCompletionResponse,
} from '../../types/ai';
import type { Bindings } from '../../types/bindings';
import { getConfig, decryptApiKey } from '../ai/config';
import { searchKnowledgeBase } from '../ai/knowledgeBase';
import { sendGoWaMessage } from '../gowa';

/** Timeout for AI provider requests: 30 seconds */
const AI_PROVIDER_TIMEOUT_MS = 30_000;

/** Top K results for knowledge base semantic search */
const KB_SEARCH_TOP_K = 5;

/**
 * Processes an incoming message through the full AI pipeline.
 *
 * @param job - The AI processing job from the queue
 * @param env - Cloudflare Workers environment bindings
 */
export async function processAIMessage(
  job: AIProcessingJob,
  env: Bindings
): Promise<void> {
  const { tenant_id, contact_id, sender_phone, message_content, message_type } = job;

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1: Get AI config
  // ──────────────────────────────────────────────────────────────────────────
  const config = await getConfig(env.DB, env.KV, tenant_id);
  if (!config || !config.active) {
    // No config or inactive — silently abort
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Check human takeover
  // ──────────────────────────────────────────────────────────────────────────
  const humanTakeoverKey = `human_takeover:${tenant_id}:${contact_id}`;
  const humanTakeover = await env.KV.get(humanTakeoverKey);
  if (humanTakeover) {
    // Human is handling this conversation — abort
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Check message type — only process text
  // ──────────────────────────────────────────────────────────────────────────
  if (message_type !== 'text') {
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: Check token quota
  // ──────────────────────────────────────────────────────────────────────────
  const quotaExceeded = await isTokenQuotaExceeded(env.DB, env.KV, tenant_id);
  if (quotaExceeded) {
    console.warn(
      `[AIPipeline] Token quota exceeded for tenant ${tenant_id}. Aborting.`
    );
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 5: Load conversation context
  // ──────────────────────────────────────────────────────────────────────────
  const contextMessages = await loadConversationContext(
    env.DB,
    tenant_id,
    contact_id,
    config.context_window
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Step 6: Search Knowledge Base
  // ──────────────────────────────────────────────────────────────────────────
  let kbContext = '';
  try {
    const decryptedKey = await decryptApiKey(config.api_key_encrypted, env.ENCRYPTION_KEY);
    const kbResults = await searchKnowledgeBase(
      env.DB,
      env.R2,
      tenant_id,
      message_content,
      KB_SEARCH_TOP_K,
      config.provider_url,
      decryptedKey
    );

    if (kbResults.length > 0) {
      kbContext = kbResults
        .map((entry) => `[${entry.category}] ${entry.title}: ${entry.content}`)
        .join('\n\n');
    }
  } catch (error) {
    // KB search failure is non-fatal — continue without KB context
    console.error('[AIPipeline] Knowledge base search failed:', error);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 7: Build prompt
  // ──────────────────────────────────────────────────────────────────────────
  const messages = buildPrompt(config, contextMessages, message_content, kbContext);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 8: Call AI provider
  // ──────────────────────────────────────────────────────────────────────────
  let aiResponse: ChatCompletionResponse;
  try {
    const decryptedKey = await decryptApiKey(config.api_key_encrypted, env.ENCRYPTION_KEY);
    aiResponse = await callAIProvider(config, messages, decryptedKey);
  } catch (error) {
    // AI provider error — log and abort (don't send reply)
    const errorMessage = error instanceof Error ? error.message : 'Unknown AI provider error';
    console.error(`[AIPipeline] AI provider error for tenant ${tenant_id}:`, errorMessage);

    // Log admin alert for AI provider failure
    await logAdminAlert(env.DB, 'AI_PROVIDER_ERROR', {
      tenant_id,
      contact_id,
      error: errorMessage,
    });
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 9: Extract response
  // ──────────────────────────────────────────────────────────────────────────
  const assistantContent = aiResponse.choices?.[0]?.message?.content;
  if (!assistantContent) {
    console.error(`[AIPipeline] Empty AI response for tenant ${tenant_id}`);
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 10: Send reply via GoWa
  // ──────────────────────────────────────────────────────────────────────────
  const sendResult = await sendGoWaMessage(
    env.DB,
    env.GOWA_BASE_URL,
    env.GOWA_API_KEY,
    tenant_id,
    sender_phone,
    assistantContent
  );

  if (!sendResult.success) {
    const errorDetail = 'error' in sendResult ? sendResult.error : 'Unknown error';
    console.error(
      `[AIPipeline] Failed to send reply via GoWa for tenant ${tenant_id}:`,
      errorDetail
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 11: Record token usage
  // ──────────────────────────────────────────────────────────────────────────
  try {
    await recordTokenUsage(env.DB, env.KV, tenant_id, config.model_name, aiResponse.usage);
  } catch (error) {
    // Token recording failure is non-fatal
    console.error('[AIPipeline] Failed to record token usage:', error);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 12: Store context
  // ──────────────────────────────────────────────────────────────────────────
  // The user message is already stored by the webhook handler (handleIncomingMessage).
  // The assistant reply is stored by sendGoWaMessage (it inserts into the messages table).
  // No additional storage is needed at this step.
}

// ============================================================================
// Internal Helper Functions
// ============================================================================

/**
 * Checks if a tenant's monthly token quota has been exceeded.
 * Queries D1 for the monthly token usage sum and compares against the configured limit.
 *
 * @returns true if quota exceeded, false otherwise
 */
async function isTokenQuotaExceeded(
  db: D1Database,
  kv: KVNamespace,
  tenantId: string
): Promise<boolean> {
  // Check KV cache for fast lookup
  const now = new Date();
  const monthKey = `token_usage:${tenantId}:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Get quota config
  const quota = await db
    .prepare('SELECT monthly_limit FROM token_quotas WHERE tenant_id = ?')
    .bind(tenantId)
    .first<{ monthly_limit: number }>();

  if (!quota) {
    // No quota configured — allow processing (no limit)
    return false;
  }

  // Check KV for cached monthly total
  const cachedUsage = await kv.get(monthKey);
  if (cachedUsage !== null) {
    const usage = parseInt(cachedUsage, 10);
    return usage >= quota.monthly_limit;
  }

  // Fallback: query D1 for monthly usage sum
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01T00:00:00.000Z`;
  const result = await db
    .prepare(
      `SELECT COALESCE(SUM(total_tokens), 0) as total
       FROM token_usage
       WHERE tenant_id = ? AND created_at >= ?`
    )
    .bind(tenantId, monthStart)
    .first<{ total: number }>();

  const totalUsage = result?.total ?? 0;

  // Cache the result in KV (3600s TTL)
  try {
    await kv.put(monthKey, String(totalUsage), { expirationTtl: 3600 });
  } catch {
    // Non-fatal: cache write failure
  }

  return totalUsage >= quota.monthly_limit;
}

/**
 * Loads the last N messages from the messages table for a given tenant and contact.
 * Returns them in chronological order (oldest first) for prompt construction.
 */
async function loadConversationContext(
  db: D1Database,
  tenantId: string,
  contactId: string,
  windowSize: number
): Promise<ChatCompletionMessage[]> {
  const result = await db
    .prepare(
      `SELECT sender, content, message_type
       FROM messages
       WHERE tenant_id = ? AND contact_id = ? AND message_type = 'text'
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(tenantId, contactId, windowSize)
    .all<{ sender: string; content: string; message_type: string }>();

  const rows = result.results ?? [];

  // Reverse to get chronological order (oldest first)
  const chronological = rows.reverse();

  return chronological.map((row) => ({
    role: row.sender === 'system' ? 'assistant' as const : 'user' as const,
    content: row.content,
  }));
}

/**
 * Builds the prompt messages array for the AI provider.
 * Assembles: system prompt → KB context → conversation history → current user message.
 */
function buildPrompt(
  config: AIAgentConfig,
  contextMessages: ChatCompletionMessage[],
  currentMessage: string,
  kbContext: string
): ChatCompletionMessage[] {
  const messages: ChatCompletionMessage[] = [];

  // System prompt with optional KB context
  let systemContent = config.system_prompt;
  if (kbContext) {
    systemContent += `\n\n--- Informasi Referensi ---\n${kbContext}`;
  }

  messages.push({
    role: 'system',
    content: systemContent,
  });

  // Add conversation history (prior messages)
  for (const msg of contextMessages) {
    messages.push(msg);
  }

  // Add the current user message
  messages.push({
    role: 'user',
    content: currentMessage,
  });

  return messages;
}

/**
 * Calls the AI provider using the OpenAI-compatible chat completions API.
 * Implements a 30-second timeout using AbortController.
 *
 * @throws Error on timeout, HTTP errors, or network failures
 */
async function callAIProvider(
  config: AIAgentConfig,
  messages: ChatCompletionMessage[],
  apiKey: string
): Promise<ChatCompletionResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_PROVIDER_TIMEOUT_MS);

  const endpoint = `${config.provider_url.replace(/\/$/, '')}/v1/chat/completions`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model_name,
        messages,
        temperature: config.temperature,
        max_tokens: config.max_tokens,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const statusText = response.statusText || 'Unknown';
      throw new Error(
        `AI provider returned HTTP ${response.status} (${statusText})`
      );
    }

    const data = await response.json() as ChatCompletionResponse;
    return data;
  } catch (error: unknown) {
    clearTimeout(timeoutId);

    // Check if this was a timeout (AbortError)
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('AI provider timeout after 30 seconds');
    }

    throw error;
  }
}

/**
 * Records token usage in D1 and updates the KV monthly counter.
 */
async function recordTokenUsage(
  db: D1Database,
  kv: KVNamespace,
  tenantId: string,
  model: string,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): Promise<void> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Insert into token_usage table
  await db
    .prepare(
      `INSERT INTO token_usage (id, tenant_id, model, prompt_tokens, completion_tokens, total_tokens, purpose, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      tenantId,
      model,
      usage.prompt_tokens,
      usage.completion_tokens,
      usage.total_tokens,
      'conversation',
      now
    )
    .run();

  // Update KV monthly counter
  const date = new Date();
  const monthKey = `token_usage:${tenantId}:${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

  try {
    const current = await kv.get(monthKey);
    const currentTotal = current ? parseInt(current, 10) : 0;
    const newTotal = currentTotal + usage.total_tokens;
    await kv.put(monthKey, String(newTotal), { expirationTtl: 3600 });
  } catch {
    // KV update failure is non-fatal
  }
}

/**
 * Logs an admin alert for operational issues (AI provider failures, timeouts, etc.).
 */
async function logAdminAlert(
  db: D1Database,
  alertType: string,
  detail: Record<string, unknown>
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        'INSERT INTO admin_alerts (type, detail, created_at) VALUES (?, ?, ?)'
      )
      .bind(alertType, JSON.stringify(detail), now)
      .run();
  } catch (error) {
    // Don't throw on alert logging failure
    console.error('[AIPipeline] Failed to log admin alert:', error);
  }
}
