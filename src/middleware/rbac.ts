/**
 * RBAC (Role-Based Access Control) permission checking middleware.
 * Uses Clerk Organizations permissions from the authenticated session token.
 *
 * The auth middleware must run before this middleware to set `permissions`
 * on the Hono context variables.
 */
import { MiddlewareHandler } from 'hono';
import type { Bindings, Variables } from '../types';

/**
 * Factory function that creates a Hono middleware handler to check
 * whether the authenticated user has the required permission.
 *
 * @param permission - The permission string to check (e.g., 'org:admin', 'org:broadcast:send')
 * @returns A Hono middleware handler that returns 403 if the permission is missing
 *
 * @example
 * ```typescript
 * app.get('/api/admin/something', requirePermission('org:admin'), handler);
 * app.post('/api/broadcasts', requirePermission('org:broadcast:send'), handler);
 * ```
 */
export function requirePermission(
  permission: string
): MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> {
  return async (c, next) => {
    const permissions = c.get('permissions');

    if (!permissions || !permissions.includes(permission)) {
      return c.json(
        {
          error: 'Forbidden',
          detail: `Missing required permission: ${permission}`,
        },
        403
      );
    }

    await next();
  };
}
