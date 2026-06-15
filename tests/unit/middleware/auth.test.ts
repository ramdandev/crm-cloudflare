/**
 * Unit tests for the authentication middleware.
 * Validates Requirements: 1.1, 1.4, 1.5
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createAuthMiddleware, type VerifyTokenFn } from '../../../src/middleware/auth';
import type { Bindings, Variables } from '../../../src/types';

const TEST_SECRET_KEY = 'test-clerk-secret-key';

/**
 * Creates a mock verifyToken function with configurable behavior.
 */
function createMockVerifyToken(options: {
  resolveWith?: { sub: string; org_id?: string; org_permissions?: string[] };
  rejectWith?: Error;
}): VerifyTokenFn & { calls: Array<{ token: string; options: { secretKey: string } }> } {
  const calls: Array<{ token: string; options: { secretKey: string } }> = [];

  const fn = async (token: string, opts: { secretKey: string }) => {
    calls.push({ token, options: opts });
    if (options.rejectWith) {
      throw options.rejectWith;
    }
    return options.resolveWith!;
  };

  (fn as any).calls = calls;
  return fn as VerifyTokenFn & { calls: Array<{ token: string; options: { secretKey: string } }> };
}

function createTestApp(verifyFn: VerifyTokenFn) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  app.use('/api/*', createAuthMiddleware(verifyFn));

  // Test route that returns context variables
  app.get('/api/test', (c) => {
    return c.json({
      userId: c.get('userId'),
      orgId: c.get('orgId'),
      permissions: c.get('permissions'),
    });
  });

  return app;
}

const mockEnv = {
  CLERK_SECRET_KEY: TEST_SECRET_KEY,
} as unknown as Bindings;

/**
 * Helper to send a request to the test app with the mock env bindings.
 */
async function sendRequest(app: ReturnType<typeof createTestApp>, headers?: Record<string, string>) {
  const req = new Request('http://localhost/api/test', {
    headers: new Headers(headers),
  });
  return app.request(req, undefined, mockEnv);
}

describe('authMiddleware', () => {
  describe('Missing or invalid Authorization header', () => {
    it('should return 401 when no Authorization header is present', async () => {
      const verifyFn = createMockVerifyToken({ resolveWith: { sub: 'u', org_id: 'o' } });
      const app = createTestApp(verifyFn);

      const res = await sendRequest(app);

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'Unauthorized' });
    });

    it('should return 401 when Authorization header does not start with Bearer', async () => {
      const verifyFn = createMockVerifyToken({ resolveWith: { sub: 'u', org_id: 'o' } });
      const app = createTestApp(verifyFn);

      const res = await sendRequest(app, { Authorization: 'Basic some-token' });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'Unauthorized' });
    });

    it('should return 401 when Authorization header is just "Bearer" without space and token', async () => {
      const verifyFn = createMockVerifyToken({ resolveWith: { sub: 'u', org_id: 'o' } });
      const app = createTestApp(verifyFn);

      const res = await sendRequest(app, { Authorization: 'Bearer' });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'Unauthorized' });
    });

    it('should not call verifyToken when header is missing', async () => {
      const verifyFn = createMockVerifyToken({ resolveWith: { sub: 'u', org_id: 'o' } });
      const app = createTestApp(verifyFn);

      await sendRequest(app);

      expect(verifyFn.calls.length).toBe(0);
    });

    it('should return 401 with no application data when header is missing', async () => {
      const verifyFn = createMockVerifyToken({ resolveWith: { sub: 'u', org_id: 'o' } });
      const app = createTestApp(verifyFn);

      const res = await sendRequest(app);

      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      // Should only contain the error field, no application data
      expect(Object.keys(body)).toEqual(['error']);
    });
  });

  describe('Token verification failure', () => {
    it('should return 401 when verifyToken throws an error', async () => {
      const verifyFn = createMockVerifyToken({ rejectWith: new Error('Invalid token') });
      const app = createTestApp(verifyFn);

      const res = await sendRequest(app, { Authorization: 'Bearer invalid-token' });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'Unauthorized' });
    });

    it('should return 401 with no application data when token verification fails', async () => {
      const verifyFn = createMockVerifyToken({ rejectWith: new Error('Expired token') });
      const app = createTestApp(verifyFn);

      const res = await sendRequest(app, { Authorization: 'Bearer expired-token' });

      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      // No application data leaked in the error response
      expect(body.userId).toBeUndefined();
      expect(body.orgId).toBeUndefined();
      expect(body.permissions).toBeUndefined();
    });

    it('should pass the correct secretKey to verifyToken', async () => {
      const verifyFn = createMockVerifyToken({ rejectWith: new Error('Invalid') });
      const app = createTestApp(verifyFn);

      await sendRequest(app, { Authorization: 'Bearer test-token' });

      expect(verifyFn.calls.length).toBe(1);
      expect(verifyFn.calls[0]!.token).toBe('test-token');
      expect(verifyFn.calls[0]!.options).toEqual({ secretKey: TEST_SECRET_KEY });
    });
  });

  describe('Missing organization context', () => {
    it('should return 401 when token has no org_id', async () => {
      const verifyFn = createMockVerifyToken({
        resolveWith: {
          sub: 'user_123',
          org_id: undefined,
          org_permissions: ['org:admin'],
        },
      });
      const app = createTestApp(verifyFn);

      const res = await sendRequest(app, { Authorization: 'Bearer valid-token-no-org' });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({
        error: 'Unauthorized',
        detail: 'No organization context',
      });
    });

    it('should return 401 when org_id is empty string', async () => {
      const verifyFn = createMockVerifyToken({
        resolveWith: {
          sub: 'user_123',
          org_id: '',
          org_permissions: ['org:admin'],
        },
      });
      const app = createTestApp(verifyFn);

      const res = await sendRequest(app, { Authorization: 'Bearer valid-token-empty-org' });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({
        error: 'Unauthorized',
        detail: 'No organization context',
      });
    });
  });

  describe('Successful authentication', () => {
    it('should set userId, orgId, and permissions on context when token is valid', async () => {
      const verifyFn = createMockVerifyToken({
        resolveWith: {
          sub: 'user_abc123',
          org_id: 'org_xyz789',
          org_permissions: ['org:admin', 'org:contacts:read', 'org:contacts:write'],
        },
      });
      const app = createTestApp(verifyFn);

      const res = await sendRequest(app, { Authorization: 'Bearer valid-token' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        userId: 'user_abc123',
        orgId: 'org_xyz789',
        permissions: ['org:admin', 'org:contacts:read', 'org:contacts:write'],
      });
    });

    it('should default permissions to empty array when org_permissions is undefined', async () => {
      const verifyFn = createMockVerifyToken({
        resolveWith: {
          sub: 'user_minimal',
          org_id: 'org_test',
          org_permissions: undefined,
        },
      });
      const app = createTestApp(verifyFn);

      const res = await sendRequest(app, { Authorization: 'Bearer valid-token' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        userId: 'user_minimal',
        orgId: 'org_test',
        permissions: [],
      });
    });

    it('should call next() and allow subsequent handlers to execute', async () => {
      const verifyFn = createMockVerifyToken({
        resolveWith: {
          sub: 'user_next',
          org_id: 'org_next',
          org_permissions: [],
        },
      });
      const app = createTestApp(verifyFn);

      const res = await sendRequest(app, { Authorization: 'Bearer valid-token' });

      // Route handler was reached and returned 200
      expect(res.status).toBe(200);
    });

    it('should extract the token correctly from "Bearer <token>"', async () => {
      const expectedToken = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test';
      const verifyFn = createMockVerifyToken({
        resolveWith: {
          sub: 'user_jwt',
          org_id: 'org_jwt',
          org_permissions: [],
        },
      });
      const app = createTestApp(verifyFn);

      await sendRequest(app, { Authorization: `Bearer ${expectedToken}` });

      expect(verifyFn.calls.length).toBe(1);
      expect(verifyFn.calls[0]!.token).toBe(expectedToken);
    });
  });
});
