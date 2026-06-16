/**
 * AI Configuration routes.
 * Mounted at /api/ai/config in the main app.
 *
 * Routes:
 * - GET /  — Get current tenant's AI config (api_key masked in response)
 * - PUT /  — Create or update AI config (requires org:admin permission)
 *
 * Requirements: 1.1, 1.2, 1.4, 1.5
 */

import { Hono } from 'hono';
import type { Bindings, Variables } from '../../types';
import { requirePermission } from '../../middleware/rbac';
import { getConfig, upsertConfig, maskApiKey } from '../../services/ai/config';

const aiConfigRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * GET / — Get current tenant's AI configuration.
 * Returns the config with the api_key masked for security.
 * Returns 404 if no config exists for the tenant.
 */
aiConfigRouter.get('/', async (c) => {
  const tenantId = c.get('tenantId');
  const db = c.env.DB;
  const kv = c.env.KV;

  const config = await getConfig(db, kv, tenantId);

  if (!config) {
    return c.json({ error: 'Not Found', detail: 'AI configuration not found for this tenant' }, 404);
  }

  // Mask the api_key before returning
  return c.json(
    {
      ...config,
      api_key_encrypted: maskApiKey(config.api_key_encrypted),
    },
    200
  );
});

/**
 * PUT / — Create or update AI configuration.
 * Requires org:admin permission.
 *
 * Body:
 * - provider_url: required on create, must be HTTPS
 * - api_key: required on create (stored encrypted)
 * - model_name: optional (defaults to gpt-4o-mini)
 * - system_prompt: optional, max 10000 chars
 * - max_tokens: optional, 1-16384
 * - context_window: optional, 1-50
 * - temperature: optional, 0-2
 * - enabled: optional boolean (1 or 0)
 */
aiConfigRouter.put('/', requirePermission('org:admin'), async (c) => {
  const tenantId = c.get('tenantId');
  const db = c.env.DB;
  const kv = c.env.KV;
  const encryptionKey = c.env.ENCRYPTION_KEY;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Bad Request', detail: 'Invalid JSON body' }, 400);
  }

  // Check if this is a create (no existing config) or update
  const existing = await getConfig(db, kv, tenantId);
  const isCreate = !existing;

  // Validate provider_url
  if (body.provider_url !== undefined) {
    if (typeof body.provider_url !== 'string' || body.provider_url.trim() === '') {
      return c.json(
        { error: 'Validation Error', detail: 'provider_url must be a non-empty string', field: 'provider_url' },
        400
      );
    }
    if (!body.provider_url.trim().toLowerCase().startsWith('https://')) {
      return c.json(
        { error: 'Validation Error', detail: 'provider_url must use HTTPS protocol', field: 'provider_url' },
        400
      );
    }
  } else if (isCreate) {
    return c.json(
      { error: 'Validation Error', detail: 'provider_url is required when creating a new configuration', field: 'provider_url' },
      400
    );
  }

  // Validate api_key
  if (body.api_key !== undefined) {
    if (typeof body.api_key !== 'string' || body.api_key.trim() === '') {
      return c.json(
        { error: 'Validation Error', detail: 'api_key must be a non-empty string', field: 'api_key' },
        400
      );
    }
  } else if (isCreate) {
    return c.json(
      { error: 'Validation Error', detail: 'api_key is required when creating a new configuration', field: 'api_key' },
      400
    );
  }

  // Validate model_name
  if (body.model_name !== undefined) {
    if (typeof body.model_name !== 'string' || body.model_name.trim() === '') {
      return c.json(
        { error: 'Validation Error', detail: 'model_name must be a non-empty string', field: 'model_name' },
        400
      );
    }
  }

  // Validate system_prompt (max 10000 chars)
  if (body.system_prompt !== undefined) {
    if (typeof body.system_prompt !== 'string') {
      return c.json(
        { error: 'Validation Error', detail: 'system_prompt must be a string', field: 'system_prompt' },
        400
      );
    }
    if (body.system_prompt.length > 10000) {
      return c.json(
        { error: 'Validation Error', detail: 'system_prompt must not exceed 10000 characters', field: 'system_prompt' },
        400
      );
    }
  }

  // Validate max_tokens (1-16384)
  if (body.max_tokens !== undefined) {
    const maxTokens = Number(body.max_tokens);
    if (isNaN(maxTokens) || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 16384) {
      return c.json(
        { error: 'Validation Error', detail: 'max_tokens must be an integer between 1 and 16384', field: 'max_tokens' },
        400
      );
    }
  }

  // Validate context_window (1-50)
  if (body.context_window !== undefined) {
    const contextWindow = Number(body.context_window);
    if (isNaN(contextWindow) || !Number.isInteger(contextWindow) || contextWindow < 1 || contextWindow > 50) {
      return c.json(
        { error: 'Validation Error', detail: 'context_window must be an integer between 1 and 50', field: 'context_window' },
        400
      );
    }
  }

  // Validate temperature (0-2)
  if (body.temperature !== undefined) {
    const temperature = Number(body.temperature);
    if (isNaN(temperature) || temperature < 0 || temperature > 2) {
      return c.json(
        { error: 'Validation Error', detail: 'temperature must be a number between 0 and 2', field: 'temperature' },
        400
      );
    }
  }

  // Validate enabled (0 or 1)
  if (body.enabled !== undefined) {
    const enabled = Number(body.enabled);
    if (enabled !== 0 && enabled !== 1) {
      return c.json(
        { error: 'Validation Error', detail: 'enabled must be 0 or 1', field: 'enabled' },
        400
      );
    }
  }

  // Build the config object to pass to upsertConfig
  const configData: Record<string, unknown> = {};

  if (body.provider_url !== undefined) {
    configData.provider_url = (body.provider_url as string).trim();
  }
  if (body.api_key !== undefined) {
    // Pass the raw api_key in the api_key_encrypted field; upsertConfig handles encryption
    configData.api_key_encrypted = (body.api_key as string).trim();
  }
  if (body.model_name !== undefined) {
    configData.model_name = (body.model_name as string).trim();
  }
  if (body.system_prompt !== undefined) {
    configData.system_prompt = body.system_prompt as string;
  }
  if (body.max_tokens !== undefined) {
    configData.max_tokens = Number(body.max_tokens);
  }
  if (body.context_window !== undefined) {
    configData.context_window = Number(body.context_window);
  }
  if (body.temperature !== undefined) {
    configData.temperature = Number(body.temperature);
  }
  if (body.enabled !== undefined) {
    configData.active = Number(body.enabled);
  }

  const result = await upsertConfig(db, kv, tenantId, configData, encryptionKey);

  // Mask api_key in the response
  return c.json(
    {
      ...result,
      api_key_encrypted: maskApiKey(result.api_key_encrypted),
    },
    200
  );
});

export { aiConfigRouter };
