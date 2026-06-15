/**
 * Billing routes for SaaS subscription and payment management via iPaymu.
 * Mounted at /api/billing in the main app.
 *
 * Routes:
 * - POST /payment-link  - Generate a payment link for subscription upgrade or quota purchase
 * - GET /transactions   - List transaction history (tenant-scoped, paginated)
 *
 * Requirements: 5.1, 5.2, 5.7
 */

import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { createPaymentLink, getTransactionHistory } from '../services/billing';

const billingRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * POST /payment-link - Generate a payment link for subscription upgrade or quota purchase
 *
 * Body: {
 *   type: 'subscription_upgrade' | 'quota_purchase',
 *   plan_id?: string,
 *   quota_amount?: number,
 *   amount: number,
 *   description: string
 * }
 *
 * Returns 201 with PaymentLinkResult on success.
 * Returns 400 if request body is invalid.
 * Returns 503 if iPaymu payment service is unavailable.
 *
 * Requirements: 5.1, 5.2
 */
billingRouter.post('/payment-link', async (c) => {
  const tenantId = c.get('tenantId');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Bad Request', detail: 'Invalid JSON body' }, 400);
  }

  const input = body as {
    type?: string;
    plan_id?: string;
    quota_amount?: number;
    amount?: number;
    description?: string;
  };

  // Validate required fields
  if (!input.type || !['subscription_upgrade', 'quota_purchase'].includes(input.type)) {
    return c.json(
      {
        error: 'Validation Error',
        detail: 'type must be "subscription_upgrade" or "quota_purchase"',
        field: 'type',
      },
      400
    );
  }

  if (input.amount === undefined || input.amount === null || typeof input.amount !== 'number' || input.amount <= 0) {
    return c.json(
      {
        error: 'Validation Error',
        detail: 'amount must be a positive number',
        field: 'amount',
      },
      400
    );
  }

  if (!input.description || typeof input.description !== 'string' || input.description.trim() === '') {
    return c.json(
      {
        error: 'Validation Error',
        detail: 'description is required',
        field: 'description',
      },
      400
    );
  }

  try {
    const result = await createPaymentLink(
      c.env.DB,
      c.env.IPAYMU_API_KEY,
      c.env.IPAYMU_VA,
      c.env.IPAYMU_SECRET,
      tenantId,
      {
        tenant_id: tenantId,
        type: input.type as 'subscription_upgrade' | 'quota_purchase',
        plan_id: input.plan_id,
        quota_amount: input.quota_amount,
        amount: input.amount,
        description: input.description.trim(),
      }
    );

    return c.json(result, 201);
  } catch (error) {
    // iPaymu service unavailable or errored - return 503
    const errorMessage = error instanceof Error ? error.message : 'Payment service unavailable';
    return c.json(
      {
        error: 'Service Unavailable',
        detail: errorMessage,
      },
      503
    );
  }
});

/**
 * GET /transactions - List transaction history (tenant-scoped, paginated)
 *
 * Query params:
 * - page (default 1)
 *
 * Returns 200 with paginated transaction list ordered by created_at DESC.
 *
 * Requirements: 5.7
 */
billingRouter.get('/transactions', async (c) => {
  const tenantId = c.get('tenantId');

  const pageParam = c.req.query('page');
  const page = pageParam ? parseInt(pageParam, 10) : 1;

  // Validate page parameter
  if (isNaN(page) || page < 1) {
    return c.json(
      {
        error: 'Validation Error',
        detail: 'page must be a positive integer',
        field: 'page',
      },
      400
    );
  }

  const result = await getTransactionHistory(
    c.env.DB,
    c.env.IPAYMU_API_KEY,
    c.env.IPAYMU_VA,
    c.env.IPAYMU_SECRET,
    tenantId,
    page
  );

  return c.json(result, 200);
});

export { billingRouter };
