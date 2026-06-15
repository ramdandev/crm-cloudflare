/**
 * Unit tests for rate limiting middleware.
 * Tests KV counter-based rate limiting with per-tenant configurable limits.
 *
 * Requirements: 7.1, 7.2, 7.5
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  rateLimitMiddleware,
  getCurrentWindow,
  getSecondsUntilWindowReset,
  getTenantRateLimit,
} from '../../../src/middleware/rateLimit';
import { createMockKV } from '../../helpers';
import type { Bindings, Variables } from '../../../src/types';

describe('rateLimitMiddleware', () => {
  let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
  let mockKV: KVNamespace;

  beforeEach(() => {
    mockKV = createMockKV();
    app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

    // Simulate auth + tenant middleware already having run
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-001');
      await next();
    });

    // Mount rate limit middleware
    app.use('*', rateLimitMiddleware);

    // Simple test route
    app.get('/test', (c) => c.json({ ok: true }));
  });

  it('should allow requests under the rate limit', async () => {
    const res = await app.request('/test', {}, { KV: mockKV } as unknown as Bindings);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('should increment the KV counter on each request', async () => {
    // First request
    await app.request('/test', {}, { KV: mockKV } as unknown as Bindings);

    // Verify counter was set
    const window = getCurrentWindow();
    const count = await mockKV.get(`rate:tenant-001:${window}`);
    expect(count).toBe('1');

    // Second request
    await app.request('/test', {}, { KV: mockKV } as unknown as Bindings);
    const count2 = await mockKV.get(`rate:tenant-001:${window}`);
    expect(count2).toBe('2');
  });

  it('should return 429 when rate limit is exceeded', async () => {
    // Set counter to the default limit (1000)
    const window = getCurrentWindow();
    await mockKV.put(`rate:tenant-001:${window}`, '1000');

    const res = await app.request('/test', {}, { KV: mockKV } as unknown as Bindings);
    expect(res.status).toBe(429);

    const body = (await res.json()) as { error: string; retryAfter: number };
    expect(body.error).toBe('Too Many Requests');
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(body.retryAfter).toBeLessThanOrEqual(60);
  });

  it('should include Retry-After header when rate limited', async () => {
    const window = getCurrentWindow();
    await mockKV.put(`rate:tenant-001:${window}`, '1000');

    const res = await app.request('/test', {}, { KV: mockKV } as unknown as Bindings);
    expect(res.status).toBe(429);

    const retryAfter = res.headers.get('Retry-After');
    expect(retryAfter).not.toBeNull();
    const seconds = parseInt(retryAfter!);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(60);
  });

  it('should use per-tenant configured rate limit from KV', async () => {
    // Set a custom lower limit for this tenant
    await mockKV.put(`config:tenant-001:rate_limit`, '5');

    // Set counter just below the custom limit
    const window = getCurrentWindow();
    await mockKV.put(`rate:tenant-001:${window}`, '4');

    // Request should still pass at count=4, limit=5
    const res1 = await app.request('/test', {}, { KV: mockKV } as unknown as Bindings);
    expect(res1.status).toBe(200);

    // Now counter is at 5 (incremented), next request should be rejected
    const res2 = await app.request('/test', {}, { KV: mockKV } as unknown as Bindings);
    expect(res2.status).toBe(429);
  });

  it('should gracefully bypass rate limiting when KV is unreachable', async () => {
    // Create a KV that throws on all operations
    const failingKV = {
      get: async () => { throw new Error('KV unavailable'); },
      put: async () => { throw new Error('KV unavailable'); },
      delete: async () => { throw new Error('KV unavailable'); },
      list: async () => { throw new Error('KV unavailable'); },
      getWithMetadata: async () => { throw new Error('KV unavailable'); },
    } as unknown as KVNamespace;

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.request('/test', {}, { KV: failingKV } as unknown as Bindings);
    expect(res.status).toBe(200);

    // Verify error was logged
    expect(consoleSpy).toHaveBeenCalledWith(
      'KV unavailable for rate limiting:',
      expect.any(Error)
    );

    consoleSpy.mockRestore();
  });

  it('should not rate limit if counter is at zero', async () => {
    const window = getCurrentWindow();
    await mockKV.put(`rate:tenant-001:${window}`, '0');

    const res = await app.request('/test', {}, { KV: mockKV } as unknown as Bindings);
    expect(res.status).toBe(200);
  });

  it('should rate limit different tenants independently', async () => {
    // Set up two tenant apps
    const app2 = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app2.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-002');
      await next();
    });
    app2.use('*', rateLimitMiddleware);
    app2.get('/test', (c) => c.json({ ok: true }));

    // Exhaust tenant-001's rate limit
    const window = getCurrentWindow();
    await mockKV.put(`rate:tenant-001:${window}`, '1000');

    // tenant-001 should be rate limited
    const res1 = await app.request('/test', {}, { KV: mockKV } as unknown as Bindings);
    expect(res1.status).toBe(429);

    // tenant-002 should still be allowed
    const res2 = await app2.request('/test', {}, { KV: mockKV } as unknown as Bindings);
    expect(res2.status).toBe(200);
  });
});

describe('getCurrentWindow', () => {
  it('should return a string representing the current minute window', () => {
    const window = getCurrentWindow();
    const expected = String(Math.floor(Date.now() / 60000));
    expect(window).toBe(expected);
  });

  it('should return only numeric characters', () => {
    const window = getCurrentWindow();
    expect(window).toMatch(/^\d+$/);
  });
});

describe('getSecondsUntilWindowReset', () => {
  it('should return a value between 1 and 60', () => {
    const seconds = getSecondsUntilWindowReset();
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(60);
  });
});

describe('getTenantRateLimit', () => {
  let mockKV: KVNamespace;

  beforeEach(() => {
    mockKV = createMockKV();
  });

  it('should return the configured rate limit for a tenant', async () => {
    await mockKV.put(`config:tenant-001:rate_limit`, '500');
    const limit = await getTenantRateLimit(mockKV, 'tenant-001');
    expect(limit).toBe(500);
  });

  it('should return default 1000 when no config exists', async () => {
    const limit = await getTenantRateLimit(mockKV, 'tenant-no-config');
    expect(limit).toBe(1000);
  });

  it('should return default 1000 for empty string config value', async () => {
    // parseInt('') returns NaN, which is falsy, so empty string should still parse
    // Actually parseInt('') gives NaN. Let's verify our implementation handles this.
    await mockKV.put(`config:tenant-001:rate_limit`, '');
    const limit = await getTenantRateLimit(mockKV, 'tenant-001');
    // parseInt('') = NaN, which is falsy, so the ternary should catch it
    // But our code does `config ? parseInt(config) : 1000`
    // '' is falsy, so it returns 1000
    expect(limit).toBe(1000);
  });
});
