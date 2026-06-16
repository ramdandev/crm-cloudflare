/**
 * Support Ticket routes for AI Sales Agent.
 * Mounted at /api/ai/tickets in the main app.
 *
 * Routes:
 * - POST /            — Create a support ticket
 * - GET /             — List tickets (paginated, with status/priority/type filters)
 * - GET /:id          — Get a single ticket
 * - PUT /:id/status   — Update ticket status
 * - PUT /:id/assign   — Assign ticket to staff/user
 *
 * Requirements: 12.1, 12.2, 12.3
 */

import { Hono } from 'hono';
import type { Bindings, Variables } from '../../types';
import { SupportTicketService } from '../../services/ai/tickets';

const aiTicketsRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * POST / — Create a new support ticket.
 * Body: { contact_id, type, description, priority }
 */
aiTicketsRouter.post('/', async (c) => {
  const tenantId = c.get('tenantId');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Bad Request', detail: 'Invalid JSON body' }, 400);
  }

  // Validate required fields
  if (!body.contact_id || typeof body.contact_id !== 'string') {
    return c.json({ error: 'Validation Error', detail: 'contact_id is required', field: 'contact_id' }, 400);
  }

  const validTypes = ['billing', 'technical', 'product', 'general'] as const;
  if (!body.type || !validTypes.includes(body.type as typeof validTypes[number])) {
    return c.json(
      { error: 'Validation Error', detail: `type must be one of: ${validTypes.join(', ')}`, field: 'type' },
      400
    );
  }

  if (!body.description || typeof body.description !== 'string' || (body.description as string).trim() === '') {
    return c.json({ error: 'Validation Error', detail: 'description is required', field: 'description' }, 400);
  }

  const validPriorities = ['low', 'medium', 'high', 'critical'] as const;
  const priority = (body.priority as string) || 'medium';
  if (!validPriorities.includes(priority as typeof validPriorities[number])) {
    return c.json(
      { error: 'Validation Error', detail: `priority must be one of: ${validPriorities.join(', ')}`, field: 'priority' },
      400
    );
  }

  const service = new SupportTicketService(c.env.DB);

  const ticket = await service.createTicket(
    tenantId,
    body.contact_id as string,
    body.type as 'billing' | 'technical' | 'product' | 'general',
    (body.description as string).trim(),
    priority as 'low' | 'medium' | 'high' | 'critical'
  );

  return c.json(ticket, 201);
});

/**
 * GET / — List tickets with pagination and filters.
 * Query params: status, priority, type, contact_id, assigned_to, limit, offset
 */
aiTicketsRouter.get('/', async (c) => {
  const tenantId = c.get('tenantId');

  const status = c.req.query('status');
  const priority = c.req.query('priority');
  const type = c.req.query('type');
  const contactId = c.req.query('contact_id');
  const assignedTo = c.req.query('assigned_to');
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  const service = new SupportTicketService(c.env.DB);

  const result = await service.listTickets(tenantId, {
    status: status || undefined,
    priority: priority || undefined,
    type: type || undefined,
    contact_id: contactId || undefined,
    assigned_to: assignedTo || undefined,
    limit,
    offset,
  });

  return c.json(result, 200);
});

/**
 * GET /:id — Get a single ticket by ID.
 */
aiTicketsRouter.get('/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');

  const service = new SupportTicketService(c.env.DB);
  const ticket = await service.getById(tenantId, id);

  if (!ticket) {
    return c.json({ error: 'Not Found', detail: 'Support ticket not found' }, 404);
  }

  return c.json(ticket, 200);
});

/**
 * PUT /:id/status — Update ticket status.
 * Body: { status, resolution? }
 */
aiTicketsRouter.put('/:id/status', async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Bad Request', detail: 'Invalid JSON body' }, 400);
  }

  const validStatuses = ['open', 'in_progress', 'escalated', 'resolved', 'closed'] as const;
  if (!body.status || !validStatuses.includes(body.status as typeof validStatuses[number])) {
    return c.json(
      { error: 'Validation Error', detail: `status must be one of: ${validStatuses.join(', ')}`, field: 'status' },
      400
    );
  }

  const service = new SupportTicketService(c.env.DB);

  try {
    const updated = await service.updateStatus(
      tenantId,
      id,
      body.status as 'open' | 'in_progress' | 'escalated' | 'resolved' | 'closed',
      typeof body.resolution === 'string' ? body.resolution : undefined
    );

    return c.json(updated, 200);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('not found')) {
      return c.json({ error: 'Not Found', detail: 'Support ticket not found' }, 404);
    }
    throw err;
  }
});

/**
 * PUT /:id/assign — Assign ticket to a staff member.
 * Body: { assigned_to }
 */
aiTicketsRouter.put('/:id/assign', async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Bad Request', detail: 'Invalid JSON body' }, 400);
  }

  if (!body.assigned_to || typeof body.assigned_to !== 'string') {
    return c.json({ error: 'Validation Error', detail: 'assigned_to is required', field: 'assigned_to' }, 400);
  }

  const service = new SupportTicketService(c.env.DB);

  try {
    const updated = await service.assignTicket(tenantId, id, body.assigned_to as string);
    return c.json(updated, 200);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('not found')) {
      return c.json({ error: 'Not Found', detail: 'Support ticket not found' }, 404);
    }
    throw err;
  }
});

export { aiTicketsRouter };
