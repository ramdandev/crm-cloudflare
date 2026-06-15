/**
 * Webhook routes for external service callbacks.
 * Mounted at /webhooks in the main app WITHOUT auth middleware.
 * Uses signature/token validation instead of Clerk authentication.
 *
 * Routes:
 * - POST /ipaymu - iPaymu payment callback (signature validation + idempotency)
 * - POST /gowa   - Go-Wa incoming message callback (API key validation + tenant resolution)
 *
 * Requirements: 3.2, 5.3, 10.1, 10.3
 */

import { Hono } from 'hono';
import type { Bindings } from '../types';
import { processIPaymuWebhook } from '../services/webhooks';
import { handleIncomingMessage } from '../services/gowa';
import type { IPaymuWebhook, GoWaWebhookPayload } from '../types';

/**
 * Webhook router - uses only Bindings (no Variables) since these routes
 * bypass auth/tenant middleware and perform their own validation.
 */
const webhooksRouter = new Hono<{ Bindings: Bindings }>();

/**
 * POST /ipaymu - iPaymu payment webhook callback
 *
 * Flow:
 * 1. Parse JSON body as IPaymuWebhook
 * 2. Extract source IP from request headers (cf-connecting-ip or x-forwarded-for)
 * 3. Call processIPaymuWebhook which handles:
 *    - HMAC signature validation (Req 10.1)
 *    - Idempotency check (Req 10.3)
 *    - Payment state transitions (Req 5.3, 5.4, 5.5, 5.9)
 * 4. Return the result status code and body
 *
 * No auth middleware - uses signature validation instead.
 *
 * Requirements: 5.3, 10.1, 10.3
 */
webhooksRouter.post('/ipaymu', async (c) => {
  // Step 1: Parse JSON body
  let body: IPaymuWebhook;
  try {
    body = await c.req.json<IPaymuWebhook>();
  } catch {
    return c.json({ success: false, message: 'Invalid JSON body' }, 400);
  }

  // Step 2: Extract source IP from request headers
  // Cloudflare provides cf-connecting-ip; fallback to x-forwarded-for
  const sourceIp =
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown';

  // Step 3: Process the webhook (signature validation, idempotency, state transitions)
  const result = await processIPaymuWebhook(
    c.env.DB,
    c.env.IPAYMU_SECRET,
    body,
    sourceIp
  );

  // Step 4: Return the result's status code and body
  return c.json(result.body, result.status as 200 | 400 | 401);
});

/**
 * POST /gowa - Go-Wa incoming message webhook callback
 *
 * Flow:
 * 1. Validate Go-Wa API key from Authorization Bearer header
 * 2. Parse JSON body as GoWaWebhookPayload
 * 3. Resolve tenant from X-Tenant-Id header (Go-Wa phone session mapping)
 * 4. Call handleIncomingMessage to process and store the message
 * 5. Return 200 OK
 *
 * No auth middleware - uses API key token validation instead.
 * Tenant resolution is done via X-Tenant-Id header which the Go-Wa gateway
 * is configured to send based on phone number to tenant mapping.
 *
 * Requirements: 3.2
 */
webhooksRouter.post('/gowa', async (c) => {
  // Step 1: Validate Go-Wa API key from Authorization Bearer header
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, message: 'Unauthorized: missing API key' }, 401);
  }

  const providedKey = authHeader.slice(7);
  if (providedKey !== c.env.GOWA_API_KEY) {
    return c.json({ success: false, message: 'Unauthorized: invalid API key' }, 401);
  }

  // Step 2: Parse JSON body as GoWaWebhookPayload
  let payload: GoWaWebhookPayload;
  try {
    payload = await c.req.json<GoWaWebhookPayload>();
  } catch {
    return c.json({ success: false, message: 'Invalid JSON body' }, 400);
  }

  // Validate required fields in payload
  if (!payload.from || !payload.message || !payload.type) {
    return c.json(
      { success: false, message: 'Missing required fields: from, message, type' },
      400
    );
  }

  // Step 3: Resolve tenant from X-Tenant-Id header
  // The Go-Wa gateway is configured to include the tenant ID based on
  // which phone session received the message (phone-to-tenant mapping).
  const tenantId = c.req.header('X-Tenant-Id');
  if (!tenantId || tenantId.trim() === '') {
    return c.json(
      { success: false, message: 'Missing X-Tenant-Id header for tenant resolution' },
      400
    );
  }

  // Step 4: Process the incoming message
  try {
    await handleIncomingMessage(tenantId.trim(), payload, c.env.DB, c.env.R2);
  } catch (error) {
    console.error('Failed to process Go-Wa webhook:', error);
    return c.json(
      { success: false, message: 'Internal error processing message' },
      500
    );
  }

  // Step 5: Return 200 OK
  return c.json({ success: true, message: 'Message received' }, 200);
});

export { webhooksRouter };
