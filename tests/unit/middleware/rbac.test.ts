import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requirePermission } from '../../../src/middleware/rbac';
import type { Bindings, Variables } from '../../../src/types';

/**
 * Unit tests for the RBAC permission checking middleware.
 * Validates Requirements 1.4 and 1.6.
 */
describe('requirePermission middleware', () => {
  function createApp(permission: string) {
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

    // Simulate auth middleware setting permissions
    app.use('*', async (c, next) => {
      const perms = c.req.header('X-Test-Permissions');
      if (perms) {
        c.set('permissions', perms.split(','));
      }
      // If header is absent, permissions is not set (simulates missing auth)
      await next();
    });

    app.get('/protected', requirePermission(permission), (c) => {
      return c.json({ success: true });
    });

    return app;
  }

  it('should allow access when user has the required permission', async () => {
    const app = createApp('org:admin');
    const res = await app.request('/protected', {
      headers: { 'X-Test-Permissions': 'org:admin,org:read' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
  });

  it('should return 403 when user lacks the required permission', async () => {
    const app = createApp('org:admin');
    const res = await app.request('/protected', {
      headers: { 'X-Test-Permissions': 'org:read,org:write' },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
    expect(body.detail).toBe('Missing required permission: org:admin');
  });

  it('should return 403 when permissions array is empty', async () => {
    const app = createApp('org:broadcast:send');
    const res = await app.request('/protected', {
      headers: { 'X-Test-Permissions': '' },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
    expect(body.detail).toBe('Missing required permission: org:broadcast:send');
  });

  it('should return 403 when permissions are not set on context', async () => {
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

    // No auth middleware - permissions never set
    app.get('/protected', requirePermission('org:admin'), (c) => {
      return c.json({ success: true });
    });

    const res = await app.request('/protected');

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
    expect(body.detail).toBe('Missing required permission: org:admin');
  });

  it('should check exact permission match (no partial matching)', async () => {
    const app = createApp('org:admin:full');
    const res = await app.request('/protected', {
      headers: { 'X-Test-Permissions': 'org:admin,org:admin:read' },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
    expect(body.detail).toBe('Missing required permission: org:admin:full');
  });

  it('should allow access with multiple permissions when required one is present', async () => {
    const app = createApp('org:broadcast:send');
    const res = await app.request('/protected', {
      headers: { 'X-Test-Permissions': 'org:read,org:broadcast:send,org:contacts:write' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
  });

  it('should work with different permission strings as factory argument', async () => {
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

    app.use('*', async (c, next) => {
      c.set('permissions', ['org:contacts:read']);
      await next();
    });

    app.get('/admin', requirePermission('org:admin'), (c) => {
      return c.json({ route: 'admin' });
    });

    app.get('/contacts', requirePermission('org:contacts:read'), (c) => {
      return c.json({ route: 'contacts' });
    });

    const adminRes = await app.request('/admin');
    expect(adminRes.status).toBe(403);

    const contactsRes = await app.request('/contacts');
    expect(contactsRes.status).toBe(200);
    const body = await contactsRes.json();
    expect(body).toEqual({ route: 'contacts' });
  });
});
