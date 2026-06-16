/**
 * Escalation Staff routes for AI Sales Agent.
 * Mounted at /api/ai/escalation in the main app.
 *
 * Routes:
 * - GET /staff  — List configured escalation staff
 * - PUT /staff  — Configure escalation staff (admin only)
 *
 * Requirements: 9.1, 9.2, 9.3
 */

import { Hono } from 'hono';
import type { Bindings, Variables } from '../../types';
import { requirePermission } from '../../middleware/rbac';
import { EscalationService } from '../../services/ai/escalation';

const aiEscalationRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * GET /staff — List all active escalation staff for the tenant.
 * Returns staff ordered by priority.
 */
aiEscalationRouter.get('/staff', async (c) => {
  const tenantId = c.get('tenantId');

  const service = new EscalationService(c.env.DB, c.env.KV);
  const staff = await service.getStaff(tenantId);

  return c.json({ staff }, 200);
});

/**
 * PUT /staff — Configure escalation staff for the tenant.
 * Requires org:admin permission.
 * Replaces all existing staff with the provided list.
 *
 * Body: { staff: Array<{ name, phone_number, priority_order, specialties? }> }
 */
aiEscalationRouter.put('/staff', requirePermission('org:admin'), async (c) => {
  const tenantId = c.get('tenantId');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Bad Request', detail: 'Invalid JSON body' }, 400);
  }

  if (!Array.isArray(body.staff)) {
    return c.json({ error: 'Validation Error', detail: 'staff must be an array', field: 'staff' }, 400);
  }

  // Validate each staff entry
  for (let i = 0; i < body.staff.length; i++) {
    const member = body.staff[i] as Record<string, unknown>;

    if (!member.name || typeof member.name !== 'string' || (member.name as string).trim() === '') {
      return c.json(
        { error: 'Validation Error', detail: `staff[${i}].name is required`, field: `staff[${i}].name` },
        400
      );
    }

    if (!member.phone_number || typeof member.phone_number !== 'string' || (member.phone_number as string).trim() === '') {
      return c.json(
        { error: 'Validation Error', detail: `staff[${i}].phone_number is required`, field: `staff[${i}].phone_number` },
        400
      );
    }

    if (member.priority_order === undefined || typeof member.priority_order !== 'number') {
      return c.json(
        { error: 'Validation Error', detail: `staff[${i}].priority_order is required and must be a number`, field: `staff[${i}].priority_order` },
        400
      );
    }
  }

  const service = new EscalationService(c.env.DB, c.env.KV);

  const configured = await service.configureStaff(
    tenantId,
    (body.staff as Array<Record<string, unknown>>).map((member) => ({
      name: (member.name as string).trim(),
      phone_number: (member.phone_number as string).trim(),
      priority_order: member.priority_order as number,
      specialties: Array.isArray(member.specialties) ? member.specialties as string[] : undefined,
    }))
  );

  return c.json({ staff: configured }, 200);
});

export { aiEscalationRouter };
