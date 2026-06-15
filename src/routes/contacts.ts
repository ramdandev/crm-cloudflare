/**
 * Contact management routes for the Omnichannel SaaS CRM.
 * Mounted at /api/contacts in the main app.
 *
 * Routes:
 * - POST /        - Create a new contact
 * - GET /         - List contacts (paginated)
 * - GET /:id      - Get a single contact
 * - PUT /:id      - Update a contact
 * - DELETE /:id   - Delete a contact
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { validateCreateContact, validateUpdateContact } from '../validators/contact';
import {
  createContact,
  listContacts,
  getContactById,
  updateContact,
  deleteContact,
} from '../services/contacts';

const contactsRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * POST / - Create a new contact
 * Body: { full_name, phone_number?, email?, metadata? }
 * Returns 201 with the created contact on success.
 * Returns 400 with validation errors if input is invalid.
 */
contactsRouter.post('/', async (c) => {
  const tenantId = c.get('tenantId');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Bad Request', detail: 'Invalid JSON body' }, 400);
  }

  const input = body as { full_name?: string; phone_number?: string; email?: string; metadata?: Record<string, unknown> };

  const validation = validateCreateContact({
    full_name: input.full_name || '',
    phone_number: input.phone_number,
    email: input.email,
    metadata: input.metadata,
  });

  if (!validation.valid && validation.errors.length > 0) {
    const firstError = validation.errors[0]!;
    return c.json(
      {
        error: 'Validation Error',
        detail: firstError.message,
        field: firstError.field,
      },
      400
    );
  }

  const contact = await createContact(c.env.DB, tenantId, {
    full_name: input.full_name!,
    phone_number: input.phone_number,
    email: input.email,
    metadata: input.metadata,
  });

  return c.json(contact, 201);
});

/**
 * GET / - List contacts with pagination
 * Query params: page (default 1), pageSize (default 50, max 50)
 * Returns 200 with paginated result.
 */
contactsRouter.get('/', async (c) => {
  const tenantId = c.get('tenantId');

  const pageParam = c.req.query('page');
  const pageSizeParam = c.req.query('pageSize');

  const page = pageParam ? parseInt(pageParam, 10) : 1;
  const pageSize = pageSizeParam ? parseInt(pageSizeParam, 10) : 50;

  // Validate pagination params are valid numbers
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

  const result = await listContacts(c.env.DB, tenantId, page, pageSize);
  return c.json(result, 200);
});

/**
 * GET /:id - Get a single contact by ID
 * Returns 200 with the contact or 404 if not found.
 */
contactsRouter.get('/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const contactId = c.req.param('id');

  const contact = await getContactById(c.env.DB, tenantId, contactId);

  if (!contact) {
    return c.json({ error: 'Not Found', detail: 'Contact not found' }, 404);
  }

  return c.json(contact, 200);
});

/**
 * PUT /:id - Update an existing contact
 * Body: { full_name?, phone_number?, email?, metadata? }
 * Returns 200 with the updated contact or 404 if not found.
 * Returns 400 with validation errors if input is invalid.
 */
contactsRouter.put('/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const contactId = c.req.param('id');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Bad Request', detail: 'Invalid JSON body' }, 400);
  }

  const input = body as { full_name?: string; phone_number?: string; email?: string; metadata?: Record<string, unknown> };

  const validation = validateUpdateContact({
    full_name: input.full_name,
    phone_number: input.phone_number,
    email: input.email,
    metadata: input.metadata,
  });

  if (!validation.valid && validation.errors.length > 0) {
    const firstError = validation.errors[0]!;
    return c.json(
      {
        error: 'Validation Error',
        detail: firstError.message,
        field: firstError.field,
      },
      400
    );
  }

  const updatedContact = await updateContact(c.env.DB, tenantId, contactId, {
    full_name: input.full_name,
    phone_number: input.phone_number,
    email: input.email,
    metadata: input.metadata,
  });

  if (!updatedContact) {
    return c.json({ error: 'Not Found', detail: 'Contact not found' }, 404);
  }

  return c.json(updatedContact, 200);
});

/**
 * DELETE /:id - Delete a contact
 * Returns 204 on success or 404 if not found.
 */
contactsRouter.delete('/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const contactId = c.req.param('id');

  const deleted = await deleteContact(c.env.DB, tenantId, contactId);

  if (!deleted) {
    return c.json({ error: 'Not Found', detail: 'Contact not found' }, 404);
  }

  return c.body(null, 204);
});

export { contactsRouter };
