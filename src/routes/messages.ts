/**
 * Message routes for WhatsApp operational messaging (Go-Wa).
 * Mounted at /api/messages in the main app.
 *
 * Routes:
 * - POST /send   - Send a message via Go-Wa gateway
 * - GET /        - List messages (paginated, tenant-scoped)
 * - GET /:id     - Get a single message
 *
 * Requirements: 3.1, 3.5
 */

import { Hono } from 'hono';
import type { Bindings, Variables, Message, MessageType } from '../types';
import { sendGoWaMessage } from '../services/gowa';

const messagesRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/** Default page size for message listing */
const DEFAULT_PAGE_SIZE = 50;

/** Maximum page size for message listing */
const MAX_PAGE_SIZE = 200;

/**
 * POST /send - Send a message via Go-Wa gateway
 *
 * Body: { recipient: string, content: string, type?: MessageType }
 *
 * Returns 200 with the sent message on success.
 * Returns 400 if required fields are missing.
 * Returns 502 if Go-Wa gateway fails.
 *
 * Requirements: 3.1
 */
messagesRouter.post('/send', async (c) => {
  const tenantId = c.get('tenantId');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Bad Request', detail: 'Invalid JSON body' }, 400);
  }

  const input = body as {
    recipient?: string;
    content?: string;
    type?: MessageType;
  };

  // Validate required fields
  if (!input.recipient || typeof input.recipient !== 'string' || input.recipient.trim() === '') {
    return c.json(
      { error: 'Validation Error', detail: 'recipient is required', field: 'recipient' },
      400
    );
  }

  if (!input.content || typeof input.content !== 'string' || input.content.trim() === '') {
    return c.json(
      { error: 'Validation Error', detail: 'content is required', field: 'content' },
      400
    );
  }

  // Validate type if provided
  const validTypes: MessageType[] = ['text', 'image', 'video', 'audio', 'document'];
  if (input.type && !validTypes.includes(input.type)) {
    return c.json(
      {
        error: 'Validation Error',
        detail: `type must be one of: ${validTypes.join(', ')}`,
        field: 'type',
      },
      400
    );
  }

  // Send message via Go-Wa service
  const result = await sendGoWaMessage(
    c.env.DB,
    c.env.GOWA_BASE_URL,
    c.env.GOWA_API_KEY,
    tenantId,
    input.recipient.trim(),
    input.content.trim(),
    input.type || 'text'
  );

  if (result.success) {
    return c.json(result.message, 200);
  }

  return c.json(
    { error: 'Gateway Error', detail: result.error, message: result.message },
    502
  );
});

/**
 * GET / - List messages with pagination (tenant-scoped)
 *
 * Query params:
 * - page (default 1)
 * - pageSize (default 50, max 200)
 *
 * Returns 200 with paginated messages ordered by created_at DESC.
 *
 * Requirements: 3.5
 */
messagesRouter.get('/', async (c) => {
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
    .prepare('SELECT COUNT(*) as total FROM messages WHERE tenant_id = ?')
    .bind(tenantId)
    .first<{ total: number }>();

  const total = countResult?.total ?? 0;

  // Fetch paginated messages ordered by created_at DESC
  const { results } = await db
    .prepare(
      'SELECT * FROM messages WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    )
    .bind(tenantId, pageSize, offset)
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

/**
 * GET /:id - Get a single message by ID (tenant-scoped)
 *
 * Returns 200 with the message or 404 if not found.
 *
 * Requirements: 3.5
 */
messagesRouter.get('/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const messageId = c.req.param('id');
  const db = c.env.DB;

  const message = await db
    .prepare('SELECT * FROM messages WHERE id = ? AND tenant_id = ?')
    .bind(messageId, tenantId)
    .first<Message>();

  if (!message) {
    return c.json({ error: 'Not Found', detail: 'Message not found' }, 404);
  }

  return c.json(message, 200);
});

export { messagesRouter };
