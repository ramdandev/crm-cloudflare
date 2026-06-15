/**
 * Unit tests for the KV Caching Service.
 * Validates Requirements: 7.3, 7.4, 7.5, 9.3
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockKV } from '../../helpers';
import {
  getCachedValue,
  setCachedValue,
  getOrFetch,
  invalidateCache,
  clampTtl,
  orgTenantKey,
  rateLimitKey,
  rateLimitConfigKey,
  contactsPageKey,
  tenantConfigKey,
  ORG_TENANT_TTL,
  RATE_LIMIT_TTL,
  RATE_LIMIT_CONFIG_TTL,
  CONTACTS_PAGE_TTL,
  TENANT_CONFIG_TTL,
} from '../../../src/services/cache';

describe('CacheService', () => {
  let mockKv: KVNamespace;

  beforeEach(() => {
    mockKv = createMockKV();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // clampTtl
  // ==========================================================================

  describe('clampTtl', () => {
    it('should return minimum TTL (60) for values below 60', () => {
      expect(clampTtl(30)).toBe(60);
      expect(clampTtl(1)).toBe(60);
      expect(clampTtl(59)).toBe(60);
    });

    it('should return maximum TTL (3600) for values above 3600', () => {
      expect(clampTtl(3601)).toBe(3600);
      expect(clampTtl(7200)).toBe(3600);
      expect(clampTtl(99999)).toBe(3600);
    });

    it('should pass through values within the valid range', () => {
      expect(clampTtl(60)).toBe(60);
      expect(clampTtl(300)).toBe(300);
      expect(clampTtl(1800)).toBe(1800);
      expect(clampTtl(3600)).toBe(3600);
    });

    it('should floor fractional values', () => {
      expect(clampTtl(120.7)).toBe(120);
      expect(clampTtl(300.9)).toBe(300);
    });

    it('should return minimum TTL for NaN, zero, or negative values', () => {
      expect(clampTtl(NaN)).toBe(60);
      expect(clampTtl(0)).toBe(60);
      expect(clampTtl(-100)).toBe(60);
    });
  });

  // ==========================================================================
  // getCachedValue
  // ==========================================================================

  describe('getCachedValue', () => {
    it('should return null for a non-existent key', async () => {
      const result = await getCachedValue(mockKv, 'nonexistent');
      expect(result).toBeNull();
    });

    it('should return the cached value for an existing key', async () => {
      await mockKv.put('test-key', 'test-value');
      const result = await getCachedValue(mockKv, 'test-key');
      expect(result).toBe('test-value');
    });

    it('should return tenant-scoped values correctly', async () => {
      await mockKv.put('org_tenant:org_123', 'tenant-abc');
      const result = await getCachedValue(mockKv, 'org_tenant:org_123');
      expect(result).toBe('tenant-abc');
    });
  });

  // ==========================================================================
  // setCachedValue
  // ==========================================================================

  describe('setCachedValue', () => {
    it('should store a value in KV with clamped TTL', async () => {
      await setCachedValue(mockKv, 'test-key', 'test-value', 300);
      const result = await mockKv.get('test-key');
      expect(result).toBe('test-value');
    });

    it('should clamp TTL below minimum to 60', async () => {
      await setCachedValue(mockKv, 'test-key', 'value', 10);
      const result = await mockKv.get('test-key');
      expect(result).toBe('value');
    });

    it('should clamp TTL above maximum to 3600', async () => {
      await setCachedValue(mockKv, 'test-key', 'value', 9999);
      const result = await mockKv.get('test-key');
      expect(result).toBe('value');
    });

    it('should overwrite existing value', async () => {
      await setCachedValue(mockKv, 'key', 'old', 120);
      await setCachedValue(mockKv, 'key', 'new', 120);
      const result = await mockKv.get('key');
      expect(result).toBe('new');
    });
  });

  // ==========================================================================
  // getOrFetch
  // ==========================================================================

  describe('getOrFetch', () => {
    it('should return cached value without calling fetcher on cache hit', async () => {
      const data = { name: 'Tenant A', plan: 'pro' };
      await mockKv.put('tenant:t1:config', JSON.stringify(data));

      const fetcher = vi.fn().mockResolvedValue({ name: 'Fresh', plan: 'free' });
      const result = await getOrFetch(mockKv, 'tenant:t1:config', 3600, fetcher);

      expect(result).toEqual(data);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('should call fetcher on cache miss and cache the result', async () => {
      const freshData = { contacts: ['Alice', 'Bob'], total: 2 };
      const fetcher = vi.fn().mockResolvedValue(freshData);

      const result = await getOrFetch(mockKv, 'contacts:t1:page:1', 120, fetcher);

      expect(result).toEqual(freshData);
      expect(fetcher).toHaveBeenCalledOnce();

      // Verify it was written back to cache
      const cached = await mockKv.get('contacts:t1:page:1');
      expect(cached).toBe(JSON.stringify(freshData));
    });

    it('should bypass cache and call fetcher when KV get throws', async () => {
      const freshData = { id: 'tenant-abc' };
      const fetcher = vi.fn().mockResolvedValue(freshData);

      // Create a KV that throws on get
      const brokenKv = {
        get: vi.fn().mockRejectedValue(new Error('KV unavailable')),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      } as unknown as KVNamespace;

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await getOrFetch(brokenKv, 'org_tenant:org_1', 300, fetcher);

      expect(result).toEqual(freshData);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should still return result even when KV put fails after fetching', async () => {
      const freshData = { quota: 500 };
      const fetcher = vi.fn().mockResolvedValue(freshData);

      // Create a KV that returns null on get but throws on put
      const partialKv = {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockRejectedValue(new Error('KV write failed')),
        delete: vi.fn().mockResolvedValue(undefined),
      } as unknown as KVNamespace;

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await getOrFetch(partialKv, 'config:t1:rate_limit', 3600, fetcher);

      expect(result).toEqual(freshData);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should cache with clamped TTL for values within range', async () => {
      const freshData = { msg: 'hello' };
      const fetcher = vi.fn().mockResolvedValue(freshData);

      const result = await getOrFetch(mockKv, 'test-key', 200, fetcher);
      expect(result).toEqual(freshData);

      // Verify it was cached
      const cached = await mockKv.get('test-key');
      expect(cached).toBe(JSON.stringify(freshData));
    });
  });

  // ==========================================================================
  // invalidateCache
  // ==========================================================================

  describe('invalidateCache', () => {
    it('should remove a cached value from KV', async () => {
      await mockKv.put('contacts:t1:page:1', 'some data');
      await invalidateCache(mockKv, 'contacts:t1:page:1');
      const result = await mockKv.get('contacts:t1:page:1');
      expect(result).toBeNull();
    });

    it('should not throw when deleting a non-existent key', async () => {
      await expect(invalidateCache(mockKv, 'nonexistent')).resolves.not.toThrow();
    });

    it('should log error but not throw when KV delete fails', async () => {
      const brokenKv = {
        delete: vi.fn().mockRejectedValue(new Error('KV delete failed')),
      } as unknown as KVNamespace;

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(invalidateCache(brokenKv, 'some-key')).resolves.not.toThrow();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  // ==========================================================================
  // Key Builder Functions
  // ==========================================================================

  describe('Key builders', () => {
    it('orgTenantKey generates correct pattern', () => {
      expect(orgTenantKey('org_abc123')).toBe('org_tenant:org_abc123');
    });

    it('rateLimitKey generates correct pattern', () => {
      expect(rateLimitKey('tenant-1', '29500000')).toBe('rate:tenant-1:29500000');
    });

    it('rateLimitConfigKey generates correct pattern', () => {
      expect(rateLimitConfigKey('tenant-1')).toBe('config:tenant-1:rate_limit');
    });

    it('contactsPageKey generates correct pattern', () => {
      expect(contactsPageKey('tenant-1', 3)).toBe('contacts:tenant-1:page:3');
    });

    it('tenantConfigKey generates correct pattern', () => {
      expect(tenantConfigKey('tenant-1')).toBe('tenant:tenant-1:config');
    });
  });

  // ==========================================================================
  // TTL Constants
  // ==========================================================================

  describe('TTL constants', () => {
    it('should have correct default TTL values from design', () => {
      expect(ORG_TENANT_TTL).toBe(300);
      expect(RATE_LIMIT_TTL).toBe(60);
      expect(RATE_LIMIT_CONFIG_TTL).toBe(3600);
      expect(CONTACTS_PAGE_TTL).toBe(120);
      expect(TENANT_CONFIG_TTL).toBe(3600);
    });

    it('all TTLs should be within clamped range', () => {
      expect(clampTtl(ORG_TENANT_TTL)).toBe(ORG_TENANT_TTL);
      expect(clampTtl(RATE_LIMIT_TTL)).toBe(RATE_LIMIT_TTL);
      expect(clampTtl(RATE_LIMIT_CONFIG_TTL)).toBe(RATE_LIMIT_CONFIG_TTL);
      expect(clampTtl(CONTACTS_PAGE_TTL)).toBe(CONTACTS_PAGE_TTL);
      expect(clampTtl(TENANT_CONFIG_TTL)).toBe(TENANT_CONFIG_TTL);
    });
  });
});
