/**
 * Broadcast routes for official WhatsApp broadcasting via Meta Cloud API.
 * Mounted at /api/broadcasts in the main app.
 *
 * Routes:
 * - POST /            - Initiate a broadcast
 * - GET /             - List broadcasts (tenant-scoped, paginated)
 * - GET /:id          - Get broadcast details with message status summary
 * - GET /:id/messages - List broadcast messages with statuses
 *
 * Requirements: 4.1, 4.5
 */

import { Hono } from 'hono';
import type { Bindings, Variables, Broadcast, BroadcastMessage } from '../types';
import {
  initiateBroadcast,
  InsufficientQuotaError,
  InvalidContactListError,
} from '../services/broadcast';

const broadcastsRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/** Default page size for broadcast listing */
const DEFAULT_PAGE_SIZE = 20;

/** Maximum page size for broadcast listing */
const MAX_PAGE_SIZE = 100;

/**
 * POST / - Initiate a broadcast
 *
 * Body: { template_name: string, template_language: string, contact_ids: string[], template_params?: Record<string, string>[] }
 *
 * Returns 202 Accepted with broadcast result on success.
 * Returns 400 if contact list is invalid.
 * Returns 402 if insufficient broadcast quota.
 *
 * Requirements: 4.1, 4.5
 */
broadcastsRouter.post('/', async (c) => {
  const tenantId = c.get('tenantId');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Bad Request', detail: 'Invalid JSON body' }, 400);
  }

  const input = body as {
    template_name?: string;
    template_language?: string;
    contact_ids?: string[];
    template_params?: Record<string, string>[];
  };

  // Validate required fields
  if (!input.template_name || typeof input.template_name !== 'string' || input.template_name.trim() === '') {
    return c.json(
      { error: 'Validation Error', detail: 'template_name is required', field: 'template_name' },
      400
    );
  }

  if (!input.template_language || typeof input.template_language !== 'string' || input.template_language.trim() === '') {
    return c.json(
      { error: 'Validation Error', detail: 'template_language is required', field: 'template_language' },
      400
    );
  }

  if (!input.contact_ids || !Array.isArray(input.contact_ids)) {
    return c.json(
      { error: 'Validation Error', detail: 'contact_ids must be an array of strings', field: 'contact_ids' },
      400
    );
  }

  try {
    const result = await initiateBroadcast(c.env.DB, c.env.BROADCAST_QUEUE, tenantId, {
      template_name: input.template_name.trim(),
      template_language: input.template_language.trim(),
      contact_ids: input.contact_ids,
      template_params: input.template_params,
    });

    return c.json(result, 202);
  } catch (error) {
    if (error instanceof InsufficientQuotaError) {
      return c.json({ error: 'Payment Required', detail: error.message }, 402);
    }
    if (error instanceof InvalidContactListError) {
      return c.json({ error: 'Bad Request', detail: error.message }, 400);
    }
    throw error;
  }
});

/**
 * GET / - List broadcasts with pagination (tenant-scoped)
 *
 * Query params:
 * - page (default 1)
 * - pageSize (default 20, max 100)
 *
 * Returns 200 with paginated broadcasts ordered by created_at DESC.
 *
 * Requirements: 4.1
 */
broadcastsRouter.get('/', async (c) => {
  const tenantId = c.get('tenantId');
  const db = c.env.DB;

  const pageParam = c.req.query('page');
  const pageSizeParam = c.req.query('pageSize');

  const page = pageParam ? parseInt(pageParam, 10) : 1;
  let pageSize = pageSizeParam ? parseInt(pageSizeParam, 10) : DEFAULT_PAGE_SIZE;

  // Validate pagination params
  if (isNaN(page) || page < 1) {
    return c.json(
      { error: 'Validation Error', detail: 'page must be a positive integer', field: 'page' },
      400
    );
  }

  if (isNaN(pageSize) || pageSize < 1) {
    return c.json(
      { error: 'Validation Error', detail: 'pageSize must be a positive integer', field: 'pageSize' },
      400
    );
  }

  // Cap pageSize at maximum
  if (pageSize > MAX_PAGE_SIZE) {
    pageSize = MAX_PAGE_SIZE;
  }

  const offset = (page - 1) * pageSize;

  // Get total count for pagination metadata
  const countResult = await db
    .prepare('SELECT COUNT(*) as total FROM broadcasts WHERE tenant_id = ?')
    .bind(tenantId)
    .first<{ total: number }>();

  const total = countResult?.total ?? 0;

  // Fetch paginated broadcasts ordered by created_at DESC
  const { results } = await db
    .prepare(
      'SELECT * FROM broadcasts WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    )
    .bind(tenantId, pageSize, offset)
    .all<Broadcast>();

  const data = results ?? [];

  return c.json(
    {
      data,
      page,
      pageSize,
      total,
      hasMore: offset + data.length < total,
    },
    200
  );
});

/**
 * GET /:id - Get broadcast details with message status summary (tenant-scoped)
 *
 * Returns 200 with broadcast record and status summary, or 404 if not found.
 *
 * Requirements: 4.1
 */
broadcastsRouter.get('/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const broadcastId = c.req.param('id');
  const db = c.env.DB;

  // Fetch broadcast record scoped to tenant
  const broadcast = await db
    .prepare('SELECT * FROM broadcasts WHERE id = ? AND tenant_id = ?')
    .bind(broadcastId, tenantId)
    .first<Broadcast>();

  if (!broadcast) {
    return c.json({ error: 'Not Found', detail: 'Broadcast not found' }, 404);
  }

  // Fetch message status summary
  const statusSummary = await db
    .prepare(
      `SELECT delivery_status, COUNT(*) as count 
       FROM broadcast_messages 
       WHERE broadcast_id = ? AND tenant_id = ? 
       GROUP BY delivery_status`
    )
    .bind(broadcastId, tenantId)
    .all<{ delivery_status: string; count: number }>();

  const summary: Record<string, number> = {};
  for (const row of statusSummary.results ?? []) {
    summary[row.delivery_status] = row.count;
  }

  return c.json(
    {
      ...broadcast,
      message_summary: summary,
    },
    200
  );
});

/**
 * GET /:id/messages - List broadcast messages with statuses (tenant-scoped, paginated)
 *
 * Query params:
 * - page (default 1)
 * - pageSize (default 20, max 100)
 *
 * Returns 200 with paginated broadcast messages, or 404 if broadcast not found.
 *
 * Requirements: 4.1
 */
broadcastsRouter.get('/:id/messages', async (c) => {
  const tenantId = c.get('tenantId');
  const broadcastId = c.req.param('id');
  const db = c.env.DB;

  // Verify broadcast exists and belongs to tenant
  const broadcast = await db
    .prepare('SELECT id FROM broadcasts WHERE id = ? AND tenant_id = ?')
    .bind(broadcastId, tenantId)
    .first<{ id: string }>();

  if (!broadcast) {
    return c.json({ error: 'Not Found', detail: 'Broadcast not found' }, 404);
  }

  const pageParam = c.req.query('page');
  const pageSizeParam = c.req.query('pageSize');

  const page = pageParam ? parseInt(pageParam, 10) : 1;
  let pageSize = pageSizeParam ? parseInt(pageSizeParam, 10) : DEFAULT_PAGE_SIZE;

  // Validate pagination params
  if (isNaN(page) || page < 1) {
    return c.json(
      { error: 'Validation Error', detail: 'page must be a positive integer', field: 'page' },
      400
    );
  }

  if (isNaN(pageSize) || pageSize < 1) {
    return c.json(
      { error: 'Validation Error', detail: 'pageSize must be a positive integer', field: 'pageSize' },
      400
    );
  }

  // Cap pageSize at maximum
  if (pageSize > MAX_PAGE_SIZE) {
    pageSize = MAX_PAGE_SIZE;
  }

  const offset = (page - 1) * pageSize;

  // Get total count
  const countResult = await db
    .prepare(
      'SELECT COUNT(*) as total FROM broadcast_messages WHERE broadcast_id = ? AND tenant_id = ?'
    )
    .bind(broadcastId, tenantId)
    .first<{ total: number }>();

  const total = countResult?.total ?? 0;

  // Fetch paginated broadcast messages
  const { results } = await db
    .prepare(
      `SELECT * FROM broadcast_messages 
       WHERE broadcast_id = ? AND tenant_id = ? 
       ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .bind(broadcastId, tenantId, pageSize, offset)
    .all<BroadcastMessage>();

  const data = results ?? [];

  return c.json(
    {
      data,
      page,
      pageSize,
      total,
      hasMore: offset + data.length < total,
    },
    200
  );
});

export { broadcastsRouter };
