/**
 * Audit log query routes for message history and compliance.
 * Mounted at /api/audit in the main app.
 *
 * Routes:
 * - GET /messages - Query message logs with filtering and pagination
 *
 * All routes require 'org:audit:read' permission via RBAC middleware.
 *
 * Requirements: 8.3, 8.4, 8.5
 */

import { Hono } from 'hono';
import type { Bindings, Variables, Message, MessageChannel, DeliveryStatus } from '../types';
import { requirePermission } from '../middleware/rbac';

const auditRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/** Default page size for audit log queries */
const DEFAULT_PAGE_SIZE = 50;

/** Maximum allowed page size */
const MAX_PAGE_SIZE = 200;

/** Valid channel values for filtering */
const VALID_CHANNELS: MessageChannel[] = ['gowa', 'meta'];

/** Valid delivery status values for filtering */
const VALID_STATUSES: DeliveryStatus[] = ['queued', 'sent', 'delivered', 'read', 'failed'];

// Apply RBAC middleware to all audit routes
auditRouter.use('/*', requirePermission('org:audit:read'));

/**
 * GET /messages - Query message logs with filtering and pagination
 *
 * Query params:
 * - page (default 1): Page number
 * - pageSize (default 50, max 200): Number of records per page
 * - channel (optional): 'gowa' | 'meta'
 * - sender (optional): Filter by sender
 * - recipient (optional): Filter by recipient
 * - delivery_status (optional): Filter by delivery status
 * - from (optional): ISO date string, start of date range (inclusive)
 * - to (optional): ISO date string, end of date range (inclusive)
 *
 * Returns messages filtered by tenant, sorted by created_at DESC.
 * Returns { data: Message[], page, pageSize, total, hasMore }
 *
 * Requirements: 8.3, 8.4, 8.5
 */
auditRouter.get('/messages', async (c) => {
  const tenantId = c.get('tenantId');
  const db = c.env.DB;

  // Parse pagination params
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

  // Parse optional filter params
  const channel = c.req.query('channel');
  const sender = c.req.query('sender');
  const recipient = c.req.query('recipient');
  const deliveryStatus = c.req.query('delivery_status');
  const fromDate = c.req.query('from');
  const toDate = c.req.query('to');

  // Validate channel filter
  if (channel && !VALID_CHANNELS.includes(channel as MessageChannel)) {
    return c.json(
      {
        error: 'Validation Error',
        detail: `channel must be one of: ${VALID_CHANNELS.join(', ')}`,
        field: 'channel',
      },
      400
    );
  }

  // Validate delivery_status filter
  if (deliveryStatus && !VALID_STATUSES.includes(deliveryStatus as DeliveryStatus)) {
    return c.json(
      {
        error: 'Validation Error',
        detail: `delivery_status must be one of: ${VALID_STATUSES.join(', ')}`,
        field: 'delivery_status',
      },
      400
    );
  }

  // Validate date formats (basic ISO date string validation)
  if (fromDate && isNaN(Date.parse(fromDate))) {
    return c.json(
      { error: 'Validation Error', detail: 'from must be a valid ISO date string', field: 'from' },
      400
    );
  }

  if (toDate && isNaN(Date.parse(toDate))) {
    return c.json(
      { error: 'Validation Error', detail: 'to must be a valid ISO date string', field: 'to' },
      400
    );
  }

  // Build dynamic WHERE clauses
  const conditions: string[] = ['tenant_id = ?'];
  const bindings: (string | number)[] = [tenantId];

  if (channel) {
    conditions.push('channel = ?');
    bindings.push(channel);
  }

  if (sender) {
    conditions.push('sender = ?');
    bindings.push(sender);
  }

  if (recipient) {
    conditions.push('recipient = ?');
    bindings.push(recipient);
  }

  if (deliveryStatus) {
    conditions.push('delivery_status = ?');
    bindings.push(deliveryStatus);
  }

  if (fromDate) {
    conditions.push('created_at >= ?');
    bindings.push(fromDate);
  }

  if (toDate) {
    conditions.push('created_at <= ?');
    bindings.push(toDate);
  }

  const whereClause = conditions.join(' AND ');
  const offset = (page - 1) * pageSize;

  // Get total count for pagination metadata
  const countQuery = `SELECT COUNT(*) as total FROM messages WHERE ${whereClause}`;
  const countResult = await db
    .prepare(countQuery)
    .bind(...bindings)
    .first<{ total: number }>();

  const total = countResult?.total ?? 0;

  // If no results, return empty result set immediately (Requirement 8.5)
  if (total === 0) {
    return c.json(
      {
        data: [],
        page,
        pageSize,
        total: 0,
        hasMore: false,
      },
      200
    );
  }

  // Fetch paginated messages sorted by created_at DESC (Requirement 8.4)
  const dataQuery = `SELECT * FROM messages WHERE ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  const { results } = await db
    .prepare(dataQuery)
    .bind(...bindings, pageSize, offset)
    .all<Message>();

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

export { auditRouter };
