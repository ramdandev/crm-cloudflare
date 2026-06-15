import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import {
  verifyTenantOwnership,
  logAccessViolation,
  checkTenantAccess,
  tenantGuardMiddleware,
  enforceTenantScope,
} from '../../../src/middleware/tenantGuard';
import { createMockD1 } from '../../helpers';
import type { Bindings, Variables } from '../../../src/types';

/**
 * Unit tests for the tenant isolation guard utility.
 * Validates Requirements 9.1, 9.4, 9.5.
 */
describe('tenantGuard', () => {
  beforeAll(async () => {
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS admin_alerts (id TEXT PRIMARY KEY, type TEXT NOT NULL, detail TEXT, source_ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
    );
  });

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM admin_alerts').run();
  });

  describe('verifyTenantOwnership', () => {
    it('should return true when session tenant_id matches resource tenant_id', () => {
      expect(verifyTenantOwnership('tenant-001', 'tenant-001')).toBe(true);
    });

    it('should return false when session tenant_id does not match resource tenant_id', () => {
      expect(verifyTenantOwnership('tenant-001', 'tenant-002')).toBe(false);
    });

    it('should return false when comparing empty strings with non-empty', () => {
      expect(verifyTenantOwnership('', 'tenant-001')).toBe(false);
      expect(verifyTenantOwnership('tenant-001', '')).toBe(false);
    });

    it('should return true when both are empty strings', () => {
      expect(verifyTenantOwnership('', '')).toBe(true);
    });

    it('should be case-sensitive', () => {
      expect(verifyTenantOwnership('Tenant-001', 'tenant-001')).toBe(false);
    });
  });

  describe('logAccessViolation', () => {
    it('should insert a CROSS_TENANT_ACCESS record into admin_alerts', async () => {
      await logAccessViolation(
        env.DB,
        'user-123',
        'contact-456',
        'tenant-001',
        'tenant-002'
      );

      const alert = await env.DB.prepare(
        "SELECT * FROM admin_alerts WHERE type = 'CROSS_TENANT_ACCESS'"
      ).first();

      expect(alert).not.toBeNull();
      expect(alert!.type).toBe('CROSS_TENANT_ACCESS');
    });

    it('should include userId, resourceId, sourceTenantId, targetTenantId in detail JSON', async () => {
      await logAccessViolation(
        env.DB,
        'user-abc',
        'resource-xyz',
        'source-tenant',
        'target-tenant'
      );

      const alert = await env.DB.prepare(
        "SELECT detail FROM admin_alerts WHERE type = 'CROSS_TENANT_ACCESS'"
      ).first<{ detail: string }>();

      const detail = JSON.parse(alert!.detail);
      expect(detail).toEqual({
        userId: 'user-abc',
        resourceId: 'resource-xyz',
        sourceTenantId: 'source-tenant',
        targetTenantId: 'target-tenant',
      });
    });

    it('should include a valid UUID as the alert id', async () => {
      await logAccessViolation(
        env.DB,
        'user-123',
        'contact-456',
        'tenant-001',
        'tenant-002'
      );

      const alert = await env.DB.prepare(
        "SELECT id FROM admin_alerts WHERE type = 'CROSS_TENANT_ACCESS'"
      ).first<{ id: string }>();

      // UUID format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      expect(alert!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('should include a valid timestamp in created_at', async () => {
      await logAccessViolation(
        env.DB,
        'user-123',
        'contact-456',
        'tenant-001',
        'tenant-002'
      );

      const alert = await env.DB.prepare(
        "SELECT created_at FROM admin_alerts WHERE type = 'CROSS_TENANT_ACCESS'"
      ).first<{ created_at: string }>();

      // Should be a valid ISO 8601 date string
      expect(new Date(alert!.created_at).toISOString()).toBe(alert!.created_at);
    });

    it('should set source_ip to null', async () => {
      await logAccessViolation(
        env.DB,
        'user-123',
        'contact-456',
        'tenant-001',
        'tenant-002'
      );

      const alert = await env.DB.prepare(
        "SELECT source_ip FROM admin_alerts WHERE type = 'CROSS_TENANT_ACCESS'"
      ).first<{ source_ip: string | null }>();

      expect(alert!.source_ip).toBeNull();
    });
  });

  describe('checkTenantAccess', () => {
    function createApp() {
      const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

      // Simulate auth + tenant middleware
      app.use('*', async (c, next) => {
        c.set('tenantId', c.req.header('X-Tenant-Id') || 'tenant-001');
        c.set('userId', c.req.header('X-User-Id') || 'user-123');
        await next();
      });

      app.get('/resource/:id', async (c) => {
        const resourceTenantId = c.req.header('X-Resource-Tenant-Id') || 'tenant-001';
        const resourceId = c.req.param('id');
        const check = await checkTenantAccess(c, resourceTenantId, resourceId);
        if (!check.allowed) return check.response!;
        return c.json({ success: true });
      });

      return app;
    }

    it('should allow access when tenant IDs match', async () => {
      const app = createApp();
      const req = new Request('http://localhost/resource/res-1', {
        headers: {
          'X-Tenant-Id': 'tenant-001',
          'X-Resource-Tenant-Id': 'tenant-001',
        },
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ success: true });
    });

    it('should return 403 when tenant IDs mismatch', async () => {
      const app = createApp();
      const req = new Request('http://localhost/resource/res-1', {
        headers: {
          'X-Tenant-Id': 'tenant-001',
          'X-Resource-Tenant-Id': 'tenant-002',
        },
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(403);
      const body = await res.json() as { error: string; detail: string };
      expect(body.error).toBe('Forbidden');
      expect(body.detail).toContain('resource belongs to another tenant');
    });

    it('should log violation to D1 on mismatch', async () => {
      const app = createApp();
      const req = new Request('http://localhost/resource/res-999', {
        headers: {
          'X-Tenant-Id': 'tenant-001',
          'X-User-Id': 'user-abc',
          'X-Resource-Tenant-Id': 'tenant-002',
        },
      });
      await app.fetch(req, env);

      const alert = await env.DB.prepare(
        "SELECT detail FROM admin_alerts WHERE type = 'CROSS_TENANT_ACCESS'"
      ).first<{ detail: string }>();

      expect(alert).not.toBeNull();
      const detail = JSON.parse(alert!.detail);
      expect(detail.userId).toBe('user-abc');
      expect(detail.resourceId).toBe('res-999');
      expect(detail.sourceTenantId).toBe('tenant-001');
      expect(detail.targetTenantId).toBe('tenant-002');
    });
  });

  describe('tenantGuardMiddleware', () => {
    function createApp(resourceLookup: Parameters<typeof tenantGuardMiddleware>[0]) {
      const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

      app.use('*', async (c, next) => {
        c.set('tenantId', c.req.header('X-Tenant-Id') || 'tenant-001');
        c.set('userId', c.req.header('X-User-Id') || 'user-123');
        await next();
      });

      const guard = tenantGuardMiddleware(resourceLookup);
      app.get('/items/:id', guard, (c) => {
        return c.json({ success: true, id: c.req.param('id') });
      });

      return app;
    }

    it('should pass through when resource tenant matches session tenant', async () => {
      const app = createApp(async (c) => ({
        tenantId: c.req.header('X-Tenant-Id') || 'tenant-001',
        resourceId: c.req.param('id') || '',
      }));

      const req = new Request('http://localhost/items/item-1', {
        headers: { 'X-Tenant-Id': 'tenant-001' },
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ success: true, id: 'item-1' });
    });

    it('should return 403 when resource tenant does not match session tenant', async () => {
      const app = createApp(async () => ({
        tenantId: 'tenant-other',
        resourceId: 'item-1',
      }));

      const req = new Request('http://localhost/items/item-1', {
        headers: { 'X-Tenant-Id': 'tenant-001' },
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Forbidden');
    });

    it('should pass through to handler when resource lookup returns null (not found)', async () => {
      const app = createApp(async () => null);

      const req = new Request('http://localhost/items/item-nonexistent', {
        headers: { 'X-Tenant-Id': 'tenant-001' },
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ success: true, id: 'item-nonexistent' });
    });

    it('should log violation when middleware blocks access', async () => {
      const app = createApp(async () => ({
        tenantId: 'tenant-evil',
        resourceId: 'secret-item',
      }));

      const req = new Request('http://localhost/items/secret-item', {
        headers: {
          'X-Tenant-Id': 'tenant-001',
          'X-User-Id': 'user-attacker',
        },
      });
      await app.fetch(req, env);

      const alert = await env.DB.prepare(
        "SELECT detail FROM admin_alerts WHERE type = 'CROSS_TENANT_ACCESS'"
      ).first<{ detail: string }>();

      expect(alert).not.toBeNull();
      const detail = JSON.parse(alert!.detail);
      expect(detail.userId).toBe('user-attacker');
      expect(detail.resourceId).toBe('secret-item');
      expect(detail.sourceTenantId).toBe('tenant-001');
      expect(detail.targetTenantId).toBe('tenant-evil');
    });
  });

  describe('enforceTenantScope', () => {
    it('should return true when job tenant matches resource tenant', async () => {
      const result = await enforceTenantScope(
        env.DB,
        'tenant-001',
        'tenant-001',
        'system',
        'broadcast-msg-123'
      );

      expect(result).toBe(true);
      // No violation should be logged
      const alert = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM admin_alerts WHERE type = 'CROSS_TENANT_ACCESS'"
      ).first<{ count: number }>();
      expect(alert!.count).toBe(0);
    });

    it('should return false and log violation when tenants mismatch', async () => {
      const result = await enforceTenantScope(
        env.DB,
        'tenant-001',
        'tenant-002',
        'queue-worker',
        'broadcast-msg-456'
      );

      expect(result).toBe(false);

      const alert = await env.DB.prepare(
        "SELECT detail FROM admin_alerts WHERE type = 'CROSS_TENANT_ACCESS'"
      ).first<{ detail: string }>();

      expect(alert).not.toBeNull();
      const detail = JSON.parse(alert!.detail);
      expect(detail.userId).toBe('queue-worker');
      expect(detail.resourceId).toBe('broadcast-msg-456');
      expect(detail.sourceTenantId).toBe('tenant-001');
      expect(detail.targetTenantId).toBe('tenant-002');
    });

    it('should work for webhook job tenant enforcement', async () => {
      const result = await enforceTenantScope(
        env.DB,
        'webhook-tenant-A',
        'webhook-tenant-A',
        'webhook-handler',
        'payment-trx-789'
      );

      expect(result).toBe(true);
      const alert = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM admin_alerts WHERE type = 'CROSS_TENANT_ACCESS'"
      ).first<{ count: number }>();
      expect(alert!.count).toBe(0);
    });

    it('should detect violation in queue jobs accessing wrong tenant resources', async () => {
      const result = await enforceTenantScope(
        env.DB,
        'tenant-A',
        'tenant-B',
        'broadcast-consumer',
        'contact-phone-123'
      );

      expect(result).toBe(false);

      const alert = await env.DB.prepare(
        "SELECT type FROM admin_alerts WHERE type = 'CROSS_TENANT_ACCESS'"
      ).first<{ type: string }>();
      expect(alert).not.toBeNull();
      expect(alert!.type).toBe('CROSS_TENANT_ACCESS');
    });
  });
});
