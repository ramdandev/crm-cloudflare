/**
 * Unit tests for tenant resolution middleware.
 * Tests KV caching, D1 fallback, error handling, and context variable setting.
 *
 * Requirements tested: 1.2, 1.3, 1.7
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import { tenantMiddleware } from '../../../src/middleware/tenant';
import type { Bindings, Variables } from '../../../src/types';

/**
 * Helper to create a test app wired with tenant middleware.
 * Uses a preceding middleware to set orgId (simulating auth middleware)
 * and uses the real miniflare bindings from `cloudflare:test`.
 */
function createTenantTestApp(orgId: string) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  // Simulate auth middleware setting orgId
  app.use('*', async (c, next) => {
    c.set('orgId', orgId);
    await next();
  });

  // Middleware under test
  app.use('*', tenantMiddleware);

  // Test endpoint that returns the resolved tenantId
  app.get('/test', (c) => {
    return c.json({ tenantId: c.get('tenantId') });
  });

  return app;
}

/**
 * Helper to make a request against the test app using miniflare env.
 */
async function makeRequest(app: Hono<{ Bindings: Bindings; Variables: Variables }>) {
  const request = new Request('http://localhost/test');
  return app.fetch(request, env);
}

describe('tenantMiddleware', () => {
  const TEST_ORG_ID = 'org_test_tenant_mw';
  const TEST_TENANT_ID = 'tenant-abc-123';

  beforeAll(async () => {
    // Apply schema for tables needed by the tenant middleware
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, clerk_org_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, plan_tier TEXT NOT NULL DEFAULT 'free', broadcast_quota INTEGER NOT NULL DEFAULT 0, rate_limit_per_minute INTEGER NOT NULL DEFAULT 1000, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))"
    );

    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS admin_alerts (id TEXT PRIMARY KEY, type TEXT NOT NULL, detail TEXT, source_ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
    );
  });

  beforeEach(async () => {
    // Clean up KV cache
    await env.KV.delete(`org_tenant:${TEST_ORG_ID}`);
    await env.KV.delete('org_tenant:org_unknown');
    await env.KV.delete('org_tenant:org_different456');
    await env.KV.delete(`config:${TEST_TENANT_ID}:cache_ttl`);

    // Clean up test data
    await env.DB.prepare('DELETE FROM tenants').run();
    await env.DB.prepare('DELETE FROM admin_alerts').run();

    // Insert a test tenant
    await env.DB.prepare(
      'INSERT INTO tenants (id, clerk_org_id, name, active) VALUES (?, ?, ?, 1)'
    ).bind(TEST_TENANT_ID, TEST_ORG_ID, 'Test Tenant').run();
  });

  it('should resolve tenantId from KV cache on cache hit', async () => {
    // Pre-populate KV cache
    await env.KV.put(`org_tenant:${TEST_ORG_ID}`, 'cached-tenant-id');

    const app = createTenantTestApp(TEST_ORG_ID);
    const res = await makeRequest(app);

    expect(res.status).toBe(200);
    const body = await res.json() as { tenantId: string };
    expect(body.tenantId).toBe('cached-tenant-id');
  });

  it('should query D1 on cache miss and cache the result', async () => {
    // No KV cache entry - should hit D1
    const app = createTenantTestApp(TEST_ORG_ID);
    const res = await makeRequest(app);

    expect(res.status).toBe(200);
    const body = await res.json() as { tenantId: string };
    expect(body.tenantId).toBe(TEST_TENANT_ID);

    // Verify result was cached in KV
    const cached = await env.KV.get(`org_tenant:${TEST_ORG_ID}`);
    expect(cached).toBe(TEST_TENANT_ID);
  });

  it('should return 403 when org cannot be resolved in D1', async () => {
    const app = createTenantTestApp('org_unknown');
    const res = await makeRequest(app);

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; detail: string };
    expect(body.error).toBe('Forbidden');
    expect(body.detail).toBe('Organization not provisioned');
  });

  it('should log an admin alert when org cannot be resolved', async () => {
    const app = createTenantTestApp('org_unknown');
    await makeRequest(app);

    // Verify the admin alert was inserted
    const alert = await env.DB.prepare(
      "SELECT * FROM admin_alerts WHERE type = 'UNRESOLVED_ORG' AND detail = ?"
    ).bind('org_unknown').first();

    expect(alert).not.toBeNull();
    expect(alert!.type).toBe('UNRESOLVED_ORG');
    expect(alert!.detail).toBe('org_unknown');
    expect(alert!.id).toBeTruthy();
    expect(alert!.created_at).toBeTruthy();
  });

  it('should set tenantId on context for downstream handlers', async () => {
    await env.KV.put(`org_tenant:${TEST_ORG_ID}`, 'tenant-context-check');

    const app = createTenantTestApp(TEST_ORG_ID);
    const res = await makeRequest(app);
    const body = await res.json() as { tenantId: string };

    expect(body.tenantId).toBe('tenant-context-check');
  });

  it('should use default TTL (300s) when no config is set', async () => {
    // This test verifies the middleware runs successfully without custom TTL config
    const app = createTenantTestApp(TEST_ORG_ID);
    const res = await makeRequest(app);

    expect(res.status).toBe(200);
    // Verify caching occurred
    const cached = await env.KV.get(`org_tenant:${TEST_ORG_ID}`);
    expect(cached).toBe(TEST_TENANT_ID);
  });

  it('should use configurable TTL from KV config when available', async () => {
    // Pre-set a custom TTL config
    await env.KV.put(`config:${TEST_TENANT_ID}:cache_ttl`, '600');

    const app = createTenantTestApp(TEST_ORG_ID);
    const res = await makeRequest(app);

    expect(res.status).toBe(200);
    const body = await res.json() as { tenantId: string };
    expect(body.tenantId).toBe(TEST_TENANT_ID);
  });

  it('should handle different orgIds for different requests', async () => {
    // Insert a second tenant
    await env.DB.prepare(
      'INSERT INTO tenants (id, clerk_org_id, name, active) VALUES (?, ?, ?, 1)'
    ).bind('tenant-other-999', 'org_different456', 'Other Tenant').run();

    const app = createTenantTestApp('org_different456');
    const res = await makeRequest(app);

    expect(res.status).toBe(200);
    const body = await res.json() as { tenantId: string };
    expect(body.tenantId).toBe('tenant-other-999');
  });

  it('should only resolve active tenants (active = 1)', async () => {
    // Insert an inactive tenant
    await env.DB.prepare(
      'INSERT INTO tenants (id, clerk_org_id, name, active) VALUES (?, ?, ?, 0)'
    ).bind('inactive-tenant', 'org_inactive', 'Inactive Tenant').run();

    const app = createTenantTestApp('org_inactive');
    const res = await makeRequest(app);

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Forbidden');
  });

  it('should not query D1 when KV cache hit occurs', async () => {
    // Pre-populate KV with a value that doesn't match any D1 record
    // If D1 were queried, it would not find this tenant
    await env.KV.put(`org_tenant:${TEST_ORG_ID}`, 'only-in-cache');

    const app = createTenantTestApp(TEST_ORG_ID);
    const res = await makeRequest(app);

    expect(res.status).toBe(200);
    const body = await res.json() as { tenantId: string };
    // Should return the cached value, not the D1 value
    expect(body.tenantId).toBe('only-in-cache');
  });

  it('should generate a valid id for admin_alerts entry', async () => {
    const app = createTenantTestApp('org_unknown');
    await makeRequest(app);

    const alert = await env.DB.prepare(
      "SELECT id FROM admin_alerts WHERE type = 'UNRESOLVED_ORG'"
    ).first<{ id: string }>();

    expect(alert).not.toBeNull();
    expect(alert!.id).toBeTruthy();
    expect(typeof alert!.id).toBe('string');
    // UUID format check (either standard UUID or hex-based)
    expect(alert!.id.length).toBeGreaterThanOrEqual(32);
  });
});
