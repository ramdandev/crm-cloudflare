/**
 * Tenant resolution middleware.
 * Resolves Clerk Organization ID to internal Tenant ID using KV cache with D1 fallback.
 * Runs AFTER auth middleware, so `orgId` is already available on the context.
 *
 * Flow:
 * 1. Check KV cache for org_tenant:{orgId}
 * 2. On cache miss, query D1 tenants table
 * 3. Cache the result with configurable TTL (default 300s)
 * 4. Return 403 and log admin alert if org cannot be resolved
 * 5. Set tenantId on Hono context for downstream handlers
 *
 * Requirements: 1.2, 1.3, 1.7
 */
import { MiddlewareHandler } from 'hono';
import type { Bindings, Variables } from '../types';

/** Default cache TTL for org-to-tenant mapping (in seconds) */
const DEFAULT_CACHE_TTL = 300;

/** Minimum allowed cache TTL (in seconds) */
const MIN_CACHE_TTL = 60;

/** Maximum allowed cache TTL (in seconds) */
const MAX_CACHE_TTL = 86400;

/**
 * Generates a hex-based UUID suitable for admin_alerts primary key.
 * Uses crypto.randomUUID() when available, falls back to hex-based generation.
 */
function generateId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Fallback: generate a hex-based UUID using random bytes
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // Set version 4 bits
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    // Set variant bits
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i]!.toString(16).padStart(2, '0');
    }
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

/**
 * Validates and clamps a TTL value to the allowed range [60, 86400].
 * Returns the default TTL if the value is not a valid positive number.
 */
function resolveTtl(ttl: number | undefined | null): number {
  if (ttl === undefined || ttl === null || isNaN(ttl) || ttl <= 0) {
    return DEFAULT_CACHE_TTL;
  }
  return Math.max(MIN_CACHE_TTL, Math.min(MAX_CACHE_TTL, Math.floor(ttl)));
}

/**
 * Tenant resolution middleware.
 * Resolves the authenticated user's Clerk Organization ID to an internal tenant_id.
 * Uses KV cache first, then falls back to D1 database.
 */
export const tenantMiddleware: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: Variables;
}> = async (c, next) => {
  const orgId = c.get('orgId');
  const kv = c.env.KV;
  const db = c.env.DB;

  // Construct cache key per KV schema: org_tenant:{clerk_org_id}
  const cacheKey = `org_tenant:${orgId}`;

  // Step 1: Check KV cache first
  let tenantId = await kv.get(cacheKey);

  if (!tenantId) {
    // Step 2: Cache miss - query D1 tenants table
    const result = await db
      .prepare('SELECT id FROM tenants WHERE clerk_org_id = ? AND active = 1')
      .bind(orgId)
      .first<{ id: string }>();

    if (!result) {
      // Step 4: Org cannot be resolved - log admin alert and return 403
      const alertId = generateId();
      await db
        .prepare(
          'INSERT INTO admin_alerts (id, type, detail, created_at) VALUES (?, ?, ?, ?)'
        )
        .bind(alertId, 'UNRESOLVED_ORG', orgId, new Date().toISOString())
        .run();

      return c.json(
        { error: 'Forbidden', detail: 'Organization not provisioned' },
        403
      );
    }

    tenantId = result.id;

    // Step 3: Cache the resolved tenant_id with configurable TTL
    // Read TTL from KV config if available, otherwise use default
    let cacheTtl = DEFAULT_CACHE_TTL;
    try {
      const configuredTtl = await kv.get(`config:${tenantId}:cache_ttl`);
      if (configuredTtl) {
        cacheTtl = resolveTtl(parseInt(configuredTtl, 10));
      }
    } catch {
      // If reading config fails, use default TTL
    }

    await kv.put(cacheKey, tenantId, { expirationTtl: cacheTtl });
  }

  // Step 5: Set tenantId on Hono context for downstream handlers
  c.set('tenantId', tenantId);
  await next();
};
