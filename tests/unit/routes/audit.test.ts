/**
 * Unit tests for audit log query routes.
 * Validates Requirements 8.3, 8.4, 8.5
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import { auditRouter } from '../../../src/routes/audit';
import type { Bindings, Variables } from '../../../src/types';

const TENANT_ID = 'tenant-audit-001';

/**
 * Creates a test app with the audit router mounted.
 * Simulates auth/tenant middleware by setting context variables.
 */
function createAuditApp(permissions: string[] = ['org:audit:read']) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  // Simulate auth + tenant middleware
  app.use('/*', async (c, next) => {
    c.set('tenantId', TENANT_ID);
    c.set('userId', 'user-001');
    c.set('orgId', 'org-001');
    c.set('permissions', permissions);
    await next();
  });

  app.route('/audit', auditRouter);
  return app;
}

function makeRequest(app: Hono<{ Bindings: Bindings; Variables: Variables }>, path: string) {
  const request = new Request(`http://localhost${path}`);
  return app.fetch(request, env);
}

describe('Audit Routes - GET /audit/messages', () => {
  beforeAll(async () => {
    // Create messages table for audit queries
    await env.DB.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, contact_id TEXT, sender TEXT NOT NULL, recipient TEXT NOT NULL, message_type TEXT NOT NULL CHECK(message_type IN ('text','image','video','audio','document')), content TEXT, media_url TEXT, delivery_status TEXT NOT NULL CHECK(delivery_status IN ('queued','sent','delivered','read','failed')), channel TEXT NOT NULL CHECK(channel IN ('gowa','meta')), sender_phone TEXT, is_unlinked INTEGER NOT NULL DEFAULT 0, oversized_media INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
  });

  beforeEach(async () => {
    // Clear messages table before each test
    await env.DB.exec('DELETE FROM messages');
  });

  describe('RBAC Permission Check', () => {
    it('should return 403 when user lacks org:audit:read permission', async () => {
      const app = createAuditApp(['org:contacts:read']);
      const res = await makeRequest(app, '/audit/messages');

      expect(res.status).toBe(403);
      const body = await res.json() as { error: string; detail: string };
      expect(body.error).toBe('Forbidden');
      expect(body.detail).toBe('Missing required permission: org:audit:read');
    });

    it('should allow access when user has org:audit:read permission', async () => {
      const app = createAuditApp(['org:audit:read']);
      const res = await makeRequest(app, '/audit/messages');

      expect(res.status).toBe(200);
    });
  });

  describe('Default Pagination', () => {
    it('should return empty result set with total=0 when no matches (Req 8.5)', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages');

      expect(res.status).toBe(200);
      const body = await res.json() as { data: unknown[]; page: number; pageSize: number; total: number; hasMore: boolean };
      expect(body.data).toEqual([]);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(50);
      expect(body.total).toBe(0);
      expect(body.hasMore).toBe(false);
    });

    it('should default to page 1 and pageSize 50', async () => {
      // Insert a message for this tenant
      await env.DB.prepare(
        `INSERT INTO messages (id, tenant_id, sender, recipient, message_type, content, delivery_status, channel, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind('msg-1', TENANT_ID, '+1234', '+5678', 'text', 'Hello', 'delivered', 'gowa', '2024-03-15T10:00:00Z', '2024-03-15T10:00:00Z').run();

      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages');

      expect(res.status).toBe(200);
      const body = await res.json() as { page: number; pageSize: number; total: number; hasMore: boolean; data: unknown[] };
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(50);
      expect(body.total).toBe(1);
      expect(body.hasMore).toBe(false);
      expect(body.data).toHaveLength(1);
    });

    it('should cap pageSize at 200 (max)', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages?pageSize=500');

      expect(res.status).toBe(200);
      const body = await res.json() as { pageSize: number };
      expect(body.pageSize).toBe(200);
    });

    it('should calculate hasMore correctly', async () => {
      // Insert 3 messages
      for (let i = 0; i < 3; i++) {
        await env.DB.prepare(
          `INSERT INTO messages (id, tenant_id, sender, recipient, message_type, content, delivery_status, channel, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(`msg-${i}`, TENANT_ID, '+1234', '+5678', 'text', `Hello ${i}`, 'delivered', 'gowa', `2024-03-15T10:0${i}:00Z`, `2024-03-15T10:0${i}:00Z`).run();
      }

      const app = createAuditApp();
      // Request page 1 with pageSize 2 - should have more
      const res = await makeRequest(app, '/audit/messages?page=1&pageSize=2');

      expect(res.status).toBe(200);
      const body = await res.json() as { hasMore: boolean; data: unknown[]; total: number };
      expect(body.hasMore).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(3);
    });
  });

  describe('Pagination Validation', () => {
    it('should return 400 for invalid page parameter', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages?page=abc');

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; field: string };
      expect(body.error).toBe('Validation Error');
      expect(body.field).toBe('page');
    });

    it('should return 400 for page < 1', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages?page=0');

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; field: string };
      expect(body.field).toBe('page');
    });

    it('should return 400 for invalid pageSize parameter', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages?pageSize=-1');

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; field: string };
      expect(body.field).toBe('pageSize');
    });
  });

  describe('Filter Validation', () => {
    it('should return 400 for invalid channel value', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages?channel=invalid');

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; field: string; detail: string };
      expect(body.error).toBe('Validation Error');
      expect(body.field).toBe('channel');
      expect(body.detail).toContain('gowa');
      expect(body.detail).toContain('meta');
    });

    it('should return 400 for invalid delivery_status value', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages?delivery_status=invalid');

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; field: string };
      expect(body.field).toBe('delivery_status');
    });

    it('should return 400 for invalid from date', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages?from=not-a-date');

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; field: string };
      expect(body.field).toBe('from');
    });

    it('should return 400 for invalid to date', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages?to=not-a-date');

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; field: string };
      expect(body.field).toBe('to');
    });

    it('should accept valid channel gowa', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages?channel=gowa');
      expect(res.status).toBe(200);
    });

    it('should accept valid channel meta', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages?channel=meta');
      expect(res.status).toBe(200);
    });

    it('should accept valid delivery_status values', async () => {
      const statuses = ['queued', 'sent', 'delivered', 'read', 'failed'];
      const app = createAuditApp();
      for (const status of statuses) {
        const res = await makeRequest(app, `/audit/messages?delivery_status=${status}`);
        expect(res.status).toBe(200);
      }
    });

    it('should accept valid ISO date range', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages?from=2024-01-01T00:00:00Z&to=2024-12-31T23:59:59Z');
      expect(res.status).toBe(200);
    });
  });

  describe('Filtering Behavior', () => {
    beforeEach(async () => {
      // Insert test data with various attributes
      const messages = [
        { id: 'msg-a', sender: '+111', recipient: '+222', channel: 'gowa', status: 'delivered', ts: '2024-01-10T10:00:00Z' },
        { id: 'msg-b', sender: '+333', recipient: '+444', channel: 'meta', status: 'failed', ts: '2024-02-15T12:00:00Z' },
        { id: 'msg-c', sender: '+111', recipient: '+555', channel: 'gowa', status: 'sent', ts: '2024-03-20T14:00:00Z' },
        { id: 'msg-d', sender: '+666', recipient: '+222', channel: 'meta', status: 'delivered', ts: '2024-04-25T16:00:00Z' },
      ];

      for (const m of messages) {
        await env.DB.prepare(
          `INSERT INTO messages (id, tenant_id, sender, recipient, message_type, content, delivery_status, channel, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(m.id, TENANT_ID, m.sender, m.recipient, 'text', 'test', m.status, m.channel, m.ts, m.ts).run();
      }

      // Insert a message for another tenant - should never appear
      await env.DB.prepare(
        `INSERT INTO messages (id, tenant_id, sender, recipient, message_type, content, delivery_status, channel, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind('msg-other', 'other-tenant', '+999', '+888', 'text', 'other', 'sent', 'gowa', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z').run();
    });

    it('should filter by channel', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages?channel=meta');
      const body = await res.json() as { data: Array<{ id: string }>; total: number };

      expect(body.total).toBe(2);
      expect(body.data.every((m: { id: string }) => m.id === 'msg-b' || m.id === 'msg-d')).toBe(true);
    });

    it('should filter by sender', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages?sender=%2B111');
      const body = await res.json() as { data: Array<{ id: string }>; total: number };

      expect(body.total).toBe(2);
      expect(body.data.every((m: { id: string }) => m.id === 'msg-a' || m.id === 'msg-c')).toBe(true);
    });

    it('should filter by recipient', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages?recipient=%2B222');
      const body = await res.json() as { data: Array<{ id: string }>; total: number };

      expect(body.total).toBe(2);
      expect(body.data.every((m: { id: string }) => m.id === 'msg-a' || m.id === 'msg-d')).toBe(true);
    });

    it('should filter by delivery_status', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages?delivery_status=delivered');
      const body = await res.json() as { data: Array<{ id: string }>; total: number };

      expect(body.total).toBe(2);
      expect(body.data.every((m: { id: string }) => m.id === 'msg-a' || m.id === 'msg-d')).toBe(true);
    });

    it('should filter by date range', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages?from=2024-02-01T00:00:00Z&to=2024-03-31T23:59:59Z');
      const body = await res.json() as { data: Array<{ id: string }>; total: number };

      expect(body.total).toBe(2);
      expect(body.data.every((m: { id: string }) => m.id === 'msg-b' || m.id === 'msg-c')).toBe(true);
    });

    it('should combine multiple filters', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages?channel=gowa&sender=%2B111');
      const body = await res.json() as { data: Array<{ id: string }>; total: number };

      expect(body.total).toBe(2);
      expect(body.data.every((m: { id: string }) => m.id === 'msg-a' || m.id === 'msg-c')).toBe(true);
    });

    it('should not return messages from other tenants (tenant isolation)', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages');
      const body = await res.json() as { data: Array<{ tenant_id: string }>; total: number };

      expect(body.total).toBe(4); // only our tenant's messages
      expect(body.data.every((m: { tenant_id: string }) => m.tenant_id === TENANT_ID)).toBe(true);
    });

    it('should sort by timestamp DESC (most recent first) (Req 8.4)', async () => {
      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages');
      const body = await res.json() as { data: Array<{ created_at: string }> };

      // Verify descending order
      for (let i = 0; i < body.data.length - 1; i++) {
        expect(body.data[i].created_at >= body.data[i + 1].created_at).toBe(true);
      }
    });
  });

  describe('Response Format', () => {
    it('should return correct response format with data', async () => {
      await env.DB.prepare(
        `INSERT INTO messages (id, tenant_id, sender, recipient, message_type, content, delivery_status, channel, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind('msg-format', TENANT_ID, '+1234', '+5678', 'text', 'Hello', 'delivered', 'gowa', '2024-03-15T10:00:00Z', '2024-03-15T10:00:00Z').run();

      const app = createAuditApp();
      const res = await makeRequest(app, '/audit/messages');

      expect(res.status).toBe(200);
      const body = await res.json() as { data: unknown[]; page: number; pageSize: number; total: number; hasMore: boolean };
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('page');
      expect(body).toHaveProperty('pageSize');
      expect(body).toHaveProperty('total');
      expect(body).toHaveProperty('hasMore');
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
    });
  });
});
