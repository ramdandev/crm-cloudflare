/**
 * Appointment routes for AI Sales Agent.
 * Mounted at /api/ai/appointments in the main app.
 *
 * Routes:
 * - GET /available  — Get available slots for a date
 * - POST /          — Book an appointment
 * - GET /           — List appointments (paginated, with filters)
 * - DELETE /:id     — Cancel an appointment
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
 */

import { Hono } from 'hono';
import type { Bindings, Variables } from '../../types';
import { AppointmentService } from '../../services/ai/appointments';

const aiAppointmentsRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * GET /available — Get available time slots for a specific date.
 * Query parameter: date (required, YYYY-MM-DD format)
 */
aiAppointmentsRouter.get('/available', async (c) => {
  const tenantId = c.get('tenantId');
  const date = c.req.query('date');

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json(
      { error: 'Bad Request', detail: 'Query parameter "date" is required in YYYY-MM-DD format' },
      400
    );
  }

  const service = new AppointmentService(c.env.DB);
  const slots = await service.getAvailableSlots(tenantId, date);

  return c.json({ date, available_slots: slots }, 200);
});

/**
 * POST / — Book an appointment.
 * Body: { contact_id, date, time_start, duration_minutes, notes? }
 */
aiAppointmentsRouter.post('/', async (c) => {
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
  if (!body.date || typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return c.json({ error: 'Validation Error', detail: 'date is required in YYYY-MM-DD format', field: 'date' }, 400);
  }
  if (!body.time_start || typeof body.time_start !== 'string' || !/^\d{2}:\d{2}$/.test(body.time_start)) {
    return c.json({ error: 'Validation Error', detail: 'time_start is required in HH:MM format', field: 'time_start' }, 400);
  }

  const duration = Number(body.duration_minutes);
  if (!duration || isNaN(duration) || duration < 1) {
    return c.json({ error: 'Validation Error', detail: 'duration_minutes must be a positive number', field: 'duration_minutes' }, 400);
  }

  const service = new AppointmentService(c.env.DB);

  try {
    const appointment = await service.bookAppointment(
      tenantId,
      body.contact_id as string,
      body.date as string,
      body.time_start as string,
      duration,
      typeof body.notes === 'string' ? body.notes : undefined
    );

    return c.json(appointment, 201);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith('Time conflict')) {
      return c.json({ error: 'Conflict', detail: err.message }, 409);
    }
    throw err;
  }
});

/**
 * GET / — List appointments with pagination and filters.
 * Query params: status, date_from, date_to, contact_id, limit, offset
 */
aiAppointmentsRouter.get('/', async (c) => {
  const tenantId = c.get('tenantId');

  const status = c.req.query('status');
  const dateFrom = c.req.query('date_from');
  const dateTo = c.req.query('date_to');
  const contactId = c.req.query('contact_id');
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  const service = new AppointmentService(c.env.DB);

  const result = await service.listAppointments(tenantId, {
    status: status || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    contact_id: contactId || undefined,
    limit,
    offset,
  });

  return c.json(result, 200);
});

/**
 * DELETE /:id — Cancel an appointment.
 */
aiAppointmentsRouter.delete('/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');

  const service = new AppointmentService(c.env.DB);

  try {
    const cancelled = await service.cancelAppointment(tenantId, id);
    return c.json(cancelled, 200);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('not found')) {
      return c.json({ error: 'Not Found', detail: 'Appointment not found' }, 404);
    }
    throw err;
  }
});

export { aiAppointmentsRouter };
