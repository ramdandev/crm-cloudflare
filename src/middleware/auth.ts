/**
 * Authentication middleware that verifies Clerk session tokens
 * and extracts organization context.
 *
 * Validates Bearer tokens from the Authorization header using @clerk/backend's
 * verifyToken. On success, sets userId, orgId, and permissions on the Hono context.
 * Returns 401 Unauthorized with no application data if authentication fails.
 *
 * Requirements: 1.1, 1.4, 1.5
 */
import { MiddlewareHandler } from 'hono';
import type { Bindings, Variables } from '../types';

/**
 * Token verification function type.
 * Matches the signature of @clerk/backend's verifyToken.
 */
export type VerifyTokenFn = (
  token: string,
  options: { secretKey: string }
) => Promise<{ sub: string; org_id?: string; org_permissions?: string[] }>;

/**
 * Lazily loads the verifyToken function from @clerk/backend.
 * This avoids import issues in test environments while keeping the
 * production code using the real Clerk SDK.
 */
async function getClerkVerifyToken(): Promise<VerifyTokenFn> {
  const { verifyToken } = await import('@clerk/backend');
  return verifyToken as unknown as VerifyTokenFn;
}

/**
 * Creates the authentication middleware with an optional custom verifyToken function.
 * This allows injection of a mock verifier in tests while defaulting to
 * the real @clerk/backend verifyToken in production.
 */
export function createAuthMiddleware(
  verifyTokenFn?: VerifyTokenFn
): MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const token = authHeader.slice(7);

    try {
      const verify = verifyTokenFn || (await getClerkVerifyToken());
      const payload = await verify(token, {
        secretKey: c.env.CLERK_SECRET_KEY,
      });

      const orgId = payload.org_id;
      if (!orgId) {
        return c.json({ error: 'Unauthorized', detail: 'No organization context' }, 401);
      }

      c.set('userId', payload.sub);
      c.set('orgId', orgId);
      c.set('permissions', payload.org_permissions || []);
    } catch (error) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    await next();
  };
}

/**
 * Default authentication middleware instance using the real @clerk/backend verifyToken.
 * Use this in the main application.
 */
export const authMiddleware: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: Variables;
}> = createAuthMiddleware();
