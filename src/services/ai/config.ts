/**
 * AI Configuration Service.
 * Manages per-tenant AI agent configuration with KV caching, encryption, and provider validation.
 *
 * Requirements: 1.1, 1.2, 1.4, 1.5
 */

import type { AIAgentConfig } from '../../types/ai';

/** Cache key pattern for AI config */
const AI_CONFIG_CACHE_PREFIX = 'ai_config:';

/** TTL for AI config cache in seconds */
const AI_CONFIG_CACHE_TTL = 300;

/**
 * Builds the KV cache key for AI config.
 * Pattern: `ai_config:{tenant_id}`
 */
export function aiConfigCacheKey(tenantId: string): string {
  return `${AI_CONFIG_CACHE_PREFIX}${tenantId}`;
}

/**
 * Retrieves AI agent configuration for a tenant.
 * Checks KV cache first (300s TTL), falls back to D1 on cache miss.
 *
 * @param db - D1 database binding
 * @param kv - KV namespace binding
 * @param tenantId - The tenant ID
 * @returns The AI config or null if not configured
 */
export async function getConfig(
  db: D1Database,
  kv: KVNamespace,
  tenantId: string
): Promise<AIAgentConfig | null> {
  const cacheKey = aiConfigCacheKey(tenantId);

  // Check KV cache first
  try {
    const cached = await kv.get(cacheKey);
    if (cached !== null) {
      return JSON.parse(cached) as AIAgentConfig;
    }
  } catch (error) {
    // KV unavailable - proceed to D1 fallback
    console.error(`[AIConfigService] KV cache read failed for "${cacheKey}":`, error);
  }

  // Fallback to D1
  const result = await db
    .prepare(
      `SELECT id, tenant_id, provider_url, model_name, api_key_encrypted, system_prompt,
              temperature, max_tokens, context_window, language, tone, confidence_threshold,
              active, created_at, updated_at
       FROM ai_agent_config
       WHERE tenant_id = ?`
    )
    .bind(tenantId)
    .first<AIAgentConfig>();

  if (!result) {
    return null;
  }

  // Write to KV cache
  try {
    await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: AI_CONFIG_CACHE_TTL });
  } catch (error) {
    console.error(`[AIConfigService] KV cache write failed for "${cacheKey}":`, error);
  }

  return result;
}

/**
 * Creates or updates AI agent configuration for a tenant.
 * Encrypts the API key using AES-256-GCM before storage.
 * Validates that provider_url is HTTPS.
 * Invalidates KV cache on update.
 *
 * @param db - D1 database binding
 * @param kv - KV namespace binding
 * @param tenantId - The tenant ID
 * @param config - Partial config fields to create/update
 * @param encryptionKey - The ENCRYPTION_KEY env var for API key encryption
 * @returns The full saved AI config
 * @throws Error if provider_url is not HTTPS or validation fails
 */
export async function upsertConfig(
  db: D1Database,
  kv: KVNamespace,
  tenantId: string,
  config: Partial<AIAgentConfig>,
  encryptionKey: string
): Promise<AIAgentConfig> {
  // Validate provider_url is HTTPS
  if (config.provider_url) {
    const url = config.provider_url.trim();
    if (!url.toLowerCase().startsWith('https://')) {
      throw new Error('provider_url must use HTTPS protocol');
    }
  }

  // Check existing config
  const existing = await db
    .prepare('SELECT * FROM ai_agent_config WHERE tenant_id = ?')
    .bind(tenantId)
    .first<AIAgentConfig>();

  const now = new Date().toISOString();

  // Encrypt API key if provided
  let apiKeyEncrypted = existing?.api_key_encrypted ?? '';
  if (config.api_key_encrypted) {
    // If the caller passes the raw/plain key in api_key_encrypted field, encrypt it
    apiKeyEncrypted = await encryptApiKey(config.api_key_encrypted, encryptionKey);
  }

  if (existing) {
    // Update existing config
    const updatedConfig: AIAgentConfig = {
      id: existing.id,
      tenant_id: tenantId,
      provider_url: config.provider_url ?? existing.provider_url,
      model_name: config.model_name ?? existing.model_name,
      api_key_encrypted: apiKeyEncrypted,
      system_prompt: config.system_prompt ?? existing.system_prompt,
      temperature: config.temperature ?? existing.temperature,
      max_tokens: config.max_tokens ?? existing.max_tokens,
      context_window: config.context_window ?? existing.context_window,
      language: config.language ?? existing.language,
      tone: config.tone ?? existing.tone,
      confidence_threshold: config.confidence_threshold ?? existing.confidence_threshold,
      active: config.active ?? existing.active,
      created_at: existing.created_at,
      updated_at: now,
    };

    await db
      .prepare(
        `UPDATE ai_agent_config SET
          provider_url = ?, model_name = ?, api_key_encrypted = ?, system_prompt = ?,
          temperature = ?, max_tokens = ?, context_window = ?, language = ?, tone = ?,
          confidence_threshold = ?, active = ?, updated_at = ?
         WHERE tenant_id = ?`
      )
      .bind(
        updatedConfig.provider_url,
        updatedConfig.model_name,
        updatedConfig.api_key_encrypted,
        updatedConfig.system_prompt,
        updatedConfig.temperature,
        updatedConfig.max_tokens,
        updatedConfig.context_window,
        updatedConfig.language,
        updatedConfig.tone,
        updatedConfig.confidence_threshold,
        updatedConfig.active,
        updatedConfig.updated_at,
        tenantId
      )
      .run();

    // Invalidate KV cache
    await invalidateConfigCache(kv, tenantId);

    return updatedConfig;
  } else {
    // Create new config
    const id = crypto.randomUUID();
    const newConfig: AIAgentConfig = {
      id,
      tenant_id: tenantId,
      provider_url: config.provider_url ?? '',
      model_name: config.model_name ?? 'gpt-4o-mini',
      api_key_encrypted: apiKeyEncrypted,
      system_prompt: config.system_prompt ?? 'You are a helpful AI sales agent.',
      temperature: config.temperature ?? 0.7,
      max_tokens: config.max_tokens ?? 1024,
      context_window: config.context_window ?? 20,
      language: config.language ?? 'id',
      tone: config.tone ?? 'friendly_professional',
      confidence_threshold: config.confidence_threshold ?? 0.7,
      active: config.active ?? 1,
      created_at: now,
      updated_at: now,
    };

    await db
      .prepare(
        `INSERT INTO ai_agent_config (id, tenant_id, provider_url, model_name, api_key_encrypted,
          system_prompt, temperature, max_tokens, context_window, language, tone,
          confidence_threshold, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        newConfig.id,
        newConfig.tenant_id,
        newConfig.provider_url,
        newConfig.model_name,
        newConfig.api_key_encrypted,
        newConfig.system_prompt,
        newConfig.temperature,
        newConfig.max_tokens,
        newConfig.context_window,
        newConfig.language,
        newConfig.tone,
        newConfig.confidence_threshold,
        newConfig.active,
        newConfig.created_at,
        newConfig.updated_at
      )
      .run();

    // Invalidate KV cache (in case there was stale data)
    await invalidateConfigCache(kv, tenantId);

    return newConfig;
  }
}

/**
 * Validates an AI provider by sending a minimal chat completion request.
 * Tests that the provider URL is reachable and the API key is functional.
 *
 * @param url - The AI provider URL (must be HTTPS)
 * @param apiKey - The plain API key
 * @param model - The model name to test
 * @returns true if the provider responds successfully, false otherwise
 */
export async function validateProvider(
  url: string,
  apiKey: string,
  model: string
): Promise<boolean> {
  try {
    // Ensure URL ends with the chat completions path
    const endpoint = url.endsWith('/')
      ? `${url}chat/completions`
      : `${url}/chat/completions`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 5,
      }),
    });

    // Consider 200 and 201 as success
    return response.ok;
  } catch (error) {
    console.error('[AIConfigService] Provider validation failed:', error);
    return false;
  }
}

/**
 * Encrypts an API key using AES-256-GCM with the Web Crypto API.
 * Returns a base64-encoded string containing the IV (12 bytes) prepended to the ciphertext.
 *
 * @param plainKey - The plaintext API key to encrypt
 * @param encryptionKey - The 32-character encryption key (used as raw key material)
 * @returns Base64-encoded encrypted string (iv + ciphertext)
 */
export async function encryptApiKey(plainKey: string, encryptionKey: string): Promise<string> {
  const encoder = new TextEncoder();

  // Derive a consistent 256-bit key from the encryption key string
  const keyMaterial = encoder.encode(encryptionKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', keyMaterial);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    hashBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  // Generate a random 12-byte IV
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Encrypt the plaintext
  const plaintextBytes = encoder.encode(plainKey);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    plaintextBytes
  );

  // Combine IV + ciphertext and encode as base64
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypts an API key that was encrypted with AES-256-GCM.
 * Expects a base64-encoded string containing the IV (first 12 bytes) followed by ciphertext.
 *
 * @param encryptedKey - Base64-encoded encrypted string (iv + ciphertext)
 * @param encryptionKey - The 32-character encryption key (same as used for encryption)
 * @returns The decrypted plaintext API key
 * @throws Error if decryption fails
 */
export async function decryptApiKey(encryptedKey: string, encryptionKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Derive the same 256-bit key from the encryption key string
  const keyMaterial = encoder.encode(encryptionKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', keyMaterial);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    hashBuffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  // Decode base64 to bytes
  const combined = Uint8Array.from(atob(encryptedKey), (c) => c.charCodeAt(0));

  // Extract IV (first 12 bytes) and ciphertext (rest)
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  // Decrypt
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    ciphertext
  );

  return decoder.decode(decrypted);
}

/**
 * Masks an API key for display purposes.
 * Returns the format "sk-...{last4chars}".
 * If the key is too short (< 4 chars), returns "****".
 *
 * @param plainKey - The plaintext API key
 * @returns Masked key string
 */
export function maskApiKey(plainKey: string): string {
  if (!plainKey || plainKey.length < 4) {
    return '****';
  }
  const last4 = plainKey.slice(-4);
  return `sk-...${last4}`;
}

/**
 * Invalidates the KV cache for a tenant's AI config.
 *
 * @param kv - KV namespace binding
 * @param tenantId - The tenant ID
 */
export async function invalidateConfigCache(kv: KVNamespace, tenantId: string): Promise<void> {
  const cacheKey = aiConfigCacheKey(tenantId);
  try {
    await kv.delete(cacheKey);
  } catch (error) {
    console.error(`[AIConfigService] Cache invalidation failed for "${cacheKey}":`, error);
  }
}
