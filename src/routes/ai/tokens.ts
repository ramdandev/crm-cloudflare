/**
 * Token Usage routes for AI Sales Agent.
 * Mounted at /api/ai/tokens in the main app.
 *
 * Routes:
 * - GET /usage   — Get current month usage and quota status
 * - GET /history — Get usage history (query: start_date, end_date)
 *
 * Requirements: 13.1, 13.2, 13.3
 */

import { Hono } from 'hono';
import type { Bindings, Variables } from '../../types';
import { TokenTrackerService } from '../../services/ai/tokenTracker';

const aiTokensRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * GET /usage — Get current month's token usage and quota status.
 * Returns total usage, quota limit, and whether the quota is exceeded.
 */
aiTokensRouter.get('/usage', async (c) => {
  const tenantId = c.get('tenantId');

  const service = new TokenTrackerService();
  const quotaResult = await service.checkQuota(c.env.DB, c.env.KV, tenantId);

  return c.json(
    {
      current_month_usage: quotaResult.current,
      monthly_limit: quotaResult.limit,
      quota_exceeded: quotaResult.exceeded,
    },
    200
  );
});

/**
 * GET /history — Get token usage history for a date range.
 * Query params: start_date (YYYY-MM-DD), end_date (YYYY-MM-DD)
 * Returns daily aggregated usage.
 */
aiTokensRouter.get('/history', async (c) => {
  const tenantId = c.get('tenantId');
  const startDate = c.req.query('start_date');
  const endDate = c.req.query('end_date');

  const service = new TokenTrackerService();
  const history = await service.getUsageHistory(
    c.env.DB,
    tenantId,
    startDate || undefined,
    endDate || undefined
  );

  return c.json({ history }, 200);
});

export { aiTokensRouter };
