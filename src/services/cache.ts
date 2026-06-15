/**
 * KV Caching Service with configurable TTL and D1 fallback.
 *
 * Provides a caching layer using Cloudflare KV with tenant-scoped key patterns.
 * On cache miss: fetches from D1 (via a fetcher function), writes back to KV with configured TTL.
 * On KV unavailable: bypasses cache, serves from D1, logs unavailability event.
 *
 * Key patterns (from design):
 * - `org_tenant:{clerk_org_id}` → tenant_id (300s TTL)
 * - `rate:{tenant_id}:{window}` → count (60s TTL)
 * - `config:{tenant_id}:rate_limit` → max requests (3600s TTL)
 * - `contacts:{tenant_id}:page:{n}` → JSON contacts (120s TTL)
 * - `tenant:{tenant_id}:config` → JSON config (3600s TTL)
 *
 * TTL is clamped to [60, 3600] seconds range.
 *
 * Requirements: 7.3, 7.4, 7.5, 9.3
 */

/** Minimum allowed TTL in seconds */
const MIN_TTL = 60;

/** Maximum allowed TTL in seconds */
const MAX_TTL = 3600;

/**
 * Clamps a TTL value to the allowed range [60, 3600] seconds.
 * If the value is invalid (NaN, <= 0, undefined, null), returns the minimum TTL.
 *
 * @param ttl - The desired TTL in seconds
 * @returns The clamped TTL value
 */
export function clampTtl(ttl: number): number {
  if (ttl === undefined || ttl === null || isNaN(ttl) || ttl <= 0) {
    return MIN_TTL;
  }
  return Math.max(MIN_TTL, Math.min(MAX_TTL, Math.floor(ttl)));
}

/**
 * Retrieves a cached value from KV.
 *
 * @param kv - The KV namespace binding
 * @param key - The cache key (should be tenant-scoped per design)
 * @returns The cached value as a string, or null if not found
 */
export async function getCachedValue(kv: KVNamespace, key: string): Promise<string | null> {
  return await kv.get(key);
}

/**
 * Stores a value in KV cache with a TTL.
 * TTL is clamped to the [60, 3600] second range.
 *
 * @param kv - The KV namespace binding
 * @param key - The cache key (should be tenant-scoped per design)
 * @param value - The string value to cache
 * @param ttl - Time-to-live in seconds (clamped to 60-3600)
 */
export async function setCachedValue(kv: KVNamespace, key: string, value: string, ttl: number): Promise<void> {
  const clampedTtl = clampTtl(ttl);
  await kv.put(key, value, { expirationTtl: clampedTtl });
}

/**
 * Gets a value from cache, or fetches from the source on miss.
 * On cache hit: returns the cached value (parsed from JSON).
 * On cache miss: calls the fetcher function, caches the result, and returns it.
 * On KV error: bypasses cache entirely, calls the fetcher directly, and logs the error.
 *
 * @param kv - The KV namespace binding
 * @param key - The cache key (should be tenant-scoped per design)
 * @param ttl - Time-to-live in seconds for caching the result (clamped to 60-3600)
 * @param fetcher - Async function that retrieves the value from the source (e.g., D1)
 * @returns The value (either from cache or freshly fetched)
 */
export async function getOrFetch<T>(
  kv: KVNamespace,
  key: string,
  ttl: number,
  fetcher: () => Promise<T>
): Promise<T> {
  try {
    // Try to get from KV cache first
    const cached = await kv.get(key);
    if (cached !== null) {
      return JSON.parse(cached) as T;
    }
  } catch (error) {
    // KV unavailable - bypass cache, log event and proceed to fetcher
    console.error(`[cache] KV unavailable for key "${key}":`, error);
    // Fall through to fetcher
    const result = await fetcher();
    return result;
  }

  // Cache miss - call fetcher to get fresh data
  const result = await fetcher();

  // Write result back to KV with configured TTL
  try {
    const clampedTtl = clampTtl(ttl);
    await kv.put(key, JSON.stringify(result), { expirationTtl: clampedTtl });
  } catch (error) {
    // Failed to write to cache - log but don't fail the request
    console.error(`[cache] Failed to write cache for key "${key}":`, error);
  }

  return result;
}

/**
 * Invalidates (deletes) a cached value from KV.
 *
 * @param kv - The KV namespace binding
 * @param key - The cache key to invalidate
 */
export async function invalidateCache(kv: KVNamespace, key: string): Promise<void> {
  try {
    await kv.delete(key);
  } catch (error) {
    // KV unavailable for deletion - log but don't fail
    console.error(`[cache] Failed to invalidate cache for key "${key}":`, error);
  }
}

// ============================================================================
// Cache Key Builders (tenant-scoped per design and Requirement 9.3)
// ============================================================================

/**
 * Builds the cache key for org-to-tenant mapping.
 * Pattern: `org_tenant:{clerk_org_id}`
 * Default TTL: 300s
 */
export function orgTenantKey(clerkOrgId: string): string {
  return `org_tenant:${clerkOrgId}`;
}

/**
 * Builds the cache key for rate limiting counters.
 * Pattern: `rate:{tenant_id}:{window}`
 * Default TTL: 60s
 */
export function rateLimitKey(tenantId: string, window: string): string {
  return `rate:${tenantId}:${window}`;
}

/**
 * Builds the cache key for tenant rate limit configuration.
 * Pattern: `config:{tenant_id}:rate_limit`
 * Default TTL: 3600s
 */
export function rateLimitConfigKey(tenantId: string): string {
  return `config:${tenantId}:rate_limit`;
}

/**
 * Builds the cache key for paginated contact lists.
 * Pattern: `contacts:{tenant_id}:page:{n}`
 * Default TTL: 120s
 */
export function contactsPageKey(tenantId: string, page: number): string {
  return `contacts:${tenantId}:page:${page}`;
}

/**
 * Builds the cache key for tenant configuration.
 * Pattern: `tenant:{tenant_id}:config`
 * Default TTL: 3600s
 */
export function tenantConfigKey(tenantId: string): string {
  return `tenant:${tenantId}:config`;
}

// ============================================================================
// Default TTL Constants (exported for use by consumers)
// ============================================================================

/** Default TTL for org-to-tenant mapping cache (300 seconds) */
export const ORG_TENANT_TTL = 300;

/** Default TTL for rate limit counters (60 seconds) */
export const RATE_LIMIT_TTL = 60;

/** Default TTL for rate limit configuration cache (3600 seconds) */
export const RATE_LIMIT_CONFIG_TTL = 3600;

/** Default TTL for contact page cache (120 seconds) */
export const CONTACTS_PAGE_TTL = 120;

/** Default TTL for tenant configuration cache (3600 seconds) */
export const TENANT_CONFIG_TTL = 3600;
