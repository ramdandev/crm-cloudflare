/**
 * Rate limiting middleware using KV counters with per-tenant configurable limits.
 *
 * Enforces per-tenant API rate limits using 60-second sliding windows.
 * Key pattern: `rate:{tenantId}:{window}` where window = Math.floor(Date.now() / 60000).
 * Reads per-tenant rate limit configuration from KV or defaults to 1000 req/min.
 * Gracefully bypasses rate limiting if KV is unreachable (logs and continues).
 *
 * Requirements: 7.1, 7.2, 7.5
 */
import { MiddlewareHandler } from 'hono';
import type { Bindings, Variables } from '../types';

export const rateLimitMiddleware: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: Variables;
}> = async (c, next) => {
  const tenantId = c.get('tenantId');
  const kv = c.env.KV;

  const rateLimitKey = `rate:${tenantId}:${getCurrentWindow()}`;

  try {
    const currentCount = parseInt(await kv.get(rateLimitKey) || '0');
    const maxRequests = await getTenantRateLimit(kv, tenantId);

    if (currentCount >= maxRequests) {
      const resetSeconds = getSecondsUntilWindowReset();
      return c.json(
        { error: 'Too Many Requests', retryAfter: resetSeconds },
        429,
        { 'Retry-After': String(resetSeconds) }
      );
    }

    // Increment counter with TTL matching the window duration
    await kv.put(rateLimitKey, String(currentCount + 1), {
      expirationTtl: 60, // Window size in seconds
    });
  } catch (kvError) {
    // KV unreachable - bypass rate limiting, log event
    console.error('KV unavailable for rate limiting:', kvError);
  }

  await next();
};

/**
 * Returns the current rate limit window identifier.
 * Windows are 60 seconds (1 minute) aligned to the epoch.
 */
export function getCurrentWindow(): string {
  return String(Math.floor(Date.now() / 60000));
}

/**
 * Returns the number of seconds until the current rate limit window resets.
 * Used for the Retry-After header value.
 */
export function getSecondsUntilWindowReset(): number {
  return 60 - (Math.floor(Date.now() / 1000) % 60);
}

/**
 * Fetches the per-tenant rate limit from KV configuration.
 * Falls back to 1000 requests per minute if no tenant-specific config exists.
 *
 * @param kv - The KV namespace binding
 * @param tenantId - The tenant identifier
 * @returns The maximum number of requests allowed per minute for the tenant
 */
export async function getTenantRateLimit(kv: KVNamespace, tenantId: string): Promise<number> {
  const config = await kv.get(`config:${tenantId}:rate_limit`);
  return config ? parseInt(config) : 1000; // Default: 1000 req/min
}
