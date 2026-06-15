/**
 * Tenant isolation guard utility.
 * Provides functions and middleware to enforce cross-tenant access prevention.
 *
 * This module implements:
 * 1. `verifyTenantOwnership`: Checks if a resource's tenant_id matches the session tenant_id
 * 2. `logAccessViolation`: Logs cross-tenant access violations to D1 admin_alerts table
 * 3. `tenantGuardMiddleware`: A Hono middleware factory for route-level tenant verification
 * 4. `enforceTenantScope`: Utility for async queue/webhook jobs to enforce tenant scoping
 *
 * Requirements: 9.1, 9.4, 9.5
 */
import { MiddlewareHandler, Context } from 'hono';
import type { Bindings, Variables } from '../types';

/**
 * Verifies that a resource's tenant_id matches the authenticated session's tenant_id.
 *
 * @param sessionTenantId - The tenant ID from the authenticated session
 * @param resourceTenantId - The tenant ID associated with the resource being accessed
 * @returns true if the tenant IDs match, false if there is a mismatch (cross-tenant access)
 */
export function verifyTenantOwnership(
  sessionTenantId: string,
  resourceTenantId: string
): boolean {
  return sessionTenantId === resourceTenantId;
}

/**
 * Generates a UUID for admin_alerts primary key.
 * Uses crypto.randomUUID() when available, falls back to hex-based generation.
 */
function generateId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i]!.toString(16).padStart(2, '0');
    }
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

/**
 * Logs a cross-tenant access violation to D1 admin_alerts table.
 * Records the requesting user, resource, source tenant, and target tenant.
 *
 * INSERT format:
 * INSERT INTO admin_alerts (id, type, detail, source_ip, created_at)
 * VALUES (?, 'CROSS_TENANT_ACCESS', ?, null, ?)
 *
 * The detail field is a JSON string containing:
 * - userId: The requesting user's ID
 * - resourceId: The resource identifier that was accessed
 * - sourceTenantId: The tenant ID of the requesting user (session tenant)
 * - targetTenantId: The tenant ID of the resource being accessed
 *
 * @param db - The D1 database instance
 * @param userId - The ID of the user making the request
 * @param resourceId - The identifier of the resource being accessed
 * @param sourceTenantId - The tenant ID from the user's session (requesting tenant)
 * @param targetTenantId - The tenant ID of the resource (target tenant)
 */
export async function logAccessViolation(
  db: D1Database,
  userId: string,
  resourceId: string,
  sourceTenantId: string,
  targetTenantId: string
): Promise<void> {
  const alertId = generateId();
  const detail = JSON.stringify({
    userId,
    resourceId,
    sourceTenantId,
    targetTenantId,
  });
  const createdAt = new Date().toISOString();

  await db
    .prepare(
      'INSERT INTO admin_alerts (id, type, detail, source_ip, created_at) VALUES (?, \'CROSS_TENANT_ACCESS\', ?, null, ?)'
    )
    .bind(alertId, detail, createdAt)
    .run();
}

/**
 * Result type for tenant guard check operations.
 * Contains the check result and optionally a pre-built 403 response.
 */
export interface TenantGuardResult {
  /** Whether the resource belongs to the session tenant */
  allowed: boolean;
  /** The response to return if access is denied (only set when allowed=false) */
  response?: Response;
}

/**
 * Checks tenant ownership and logs a violation if access is denied.
 * This is a convenience function combining verifyTenantOwnership and logAccessViolation.
 *
 * Usage in route handlers:
 * ```typescript
 * const resource = await db.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first();
 * const check = await checkTenantAccess(c, resource.tenant_id, resource.id);
 * if (!check.allowed) return check.response;
 * ```
 *
 * @param c - The Hono context
 * @param resourceTenantId - The tenant_id of the resource being accessed
 * @param resourceId - The identifier of the resource (for logging)
 * @returns TenantGuardResult with allowed status and optional 403 response
 */
export async function checkTenantAccess(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  resourceTenantId: string,
  resourceId: string
): Promise<TenantGuardResult> {
  const sessionTenantId = c.get('tenantId');
  const userId = c.get('userId');

  if (verifyTenantOwnership(sessionTenantId, resourceTenantId)) {
    return { allowed: true };
  }

  // Log the access violation
  await logAccessViolation(
    c.env.DB,
    userId,
    resourceId,
    sessionTenantId,
    resourceTenantId
  );

  return {
    allowed: false,
    response: c.json(
      { error: 'Forbidden', detail: 'Access denied: resource belongs to another tenant' },
      403
    ),
  };
}

/**
 * Hono middleware factory for tenant guard enforcement.
 * Creates a middleware that extracts a resource tenant_id from the request
 * (via route param lookup or request body) and verifies it matches the session tenant.
 *
 * This is useful when you want middleware-level protection on routes where
 * a resource ID parameter can be used to look up the tenant_id before the handler runs.
 *
 * @param getResourceTenantId - An async function that extracts the resource's tenant_id
 *   from the Hono context. Should return null if the resource is not found.
 * @returns A Hono middleware handler that returns 403 on cross-tenant access
 *
 * @example
 * ```typescript
 * const contactTenantGuard = tenantGuardMiddleware(async (c) => {
 *   const contactId = c.req.param('id');
 *   const contact = await c.env.DB.prepare('SELECT tenant_id FROM contacts WHERE id = ?')
 *     .bind(contactId).first<{ tenant_id: string }>();
 *   return contact ? { tenantId: contact.tenant_id, resourceId: contactId } : null;
 * });
 *
 * app.get('/api/contacts/:id', contactTenantGuard, handler);
 * ```
 */
export function tenantGuardMiddleware(
  getResourceTenantId: (
    c: Context<{ Bindings: Bindings; Variables: Variables }>
  ) => Promise<{ tenantId: string; resourceId: string } | null>
): MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> {
  return async (c, next) => {
    const resourceInfo = await getResourceTenantId(c);

    // If resource not found, let the handler deal with 404
    if (!resourceInfo) {
      await next();
      return;
    }

    const check = await checkTenantAccess(c, resourceInfo.tenantId, resourceInfo.resourceId);
    if (!check.allowed) {
      return check.response;
    }

    await next();
  };
}

/**
 * Enforces tenant scoping for async queue/webhook jobs.
 * This utility is designed for use in queue consumers and webhook handlers
 * where there is no HTTP context, but tenant isolation must still be enforced.
 *
 * Requirements: 9.5 - Async jobs must enforce the same tenant scoping as synchronous requests.
 *
 * @param db - The D1 database instance
 * @param jobTenantId - The tenant_id associated with the job/message payload
 * @param resourceTenantId - The tenant_id of the resource being operated on
 * @param userId - The user or system ID that initiated the job (for audit logging)
 * @param resourceId - The resource identifier being accessed
 * @returns true if the tenant IDs match; false if violation was detected and logged
 */
export async function enforceTenantScope(
  db: D1Database,
  jobTenantId: string,
  resourceTenantId: string,
  userId: string,
  resourceId: string
): Promise<boolean> {
  if (verifyTenantOwnership(jobTenantId, resourceTenantId)) {
    return true;
  }

  // Log the violation for async jobs
  await logAccessViolation(db, userId, resourceId, jobTenantId, resourceTenantId);
  return false;
}
