/**
 * Contact CRUD Service with tenant-scoped queries.
 * All database operations include tenant_id as a mandatory filter
 * to ensure strict tenant data isolation.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 9.1
 */

import type { Contact, CreateContactInput, UpdateContactInput, PaginatedResult } from '../types';
import { validateCreateContact, validateUpdateContact } from '../validators/contact';

/** Maximum contacts per page for list queries */
const MAX_PAGE_SIZE = 50;

/** Default page size if not specified */
const DEFAULT_PAGE_SIZE = 50;

/**
 * ContactService provides CRUD operations for contacts,
 * always scoped to a specific tenant for data isolation.
 */
export class ContactService {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Create a new contact for a tenant.
   * Generates a UUID, validates input, and INSERTs with tenant_id.
   *
   * @param tenantId - The tenant to create the contact for
   * @param input - The contact creation input
   * @returns The created contact record
   * @throws Error if validation fails
   */
  async create(tenantId: string, input: CreateContactInput): Promise<Contact> {
    // Validate input
    const validation = validateCreateContact(input);
    if (!validation.valid) {
      const errorMessages = validation.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
      throw new Error(`Validation failed: ${errorMessages}`);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const metadataStr = input.metadata ? JSON.stringify(input.metadata) : null;

    await this.db
      .prepare(
        `INSERT INTO contacts (id, tenant_id, full_name, phone_number, email, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        tenantId,
        input.full_name,
        input.phone_number || null,
        input.email || null,
        metadataStr,
        now,
        now
      )
      .run();

    return {
      id,
      tenant_id: tenantId,
      full_name: input.full_name,
      phone_number: input.phone_number || null,
      email: input.email || null,
      metadata: metadataStr,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * List contacts for a tenant with pagination.
   * Returns a maximum of 50 contacts per page.
   *
   * @param tenantId - The tenant to list contacts for
   * @param page - The page number (1-based)
   * @param pageSize - Number of results per page (max 50)
   * @returns Paginated result with contacts
   */
  async list(
    tenantId: string,
    page: number = 1,
    pageSize: number = DEFAULT_PAGE_SIZE
  ): Promise<PaginatedResult<Contact>> {
    // Enforce page size limits
    const effectivePageSize = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE);
    const effectivePage = Math.max(1, page);
    const offset = (effectivePage - 1) * effectivePageSize;

    // Get total count for pagination metadata
    const countResult = await this.db
      .prepare('SELECT COUNT(*) as total FROM contacts WHERE tenant_id = ?')
      .bind(tenantId)
      .first<{ total: number }>();

    const total = countResult?.total ?? 0;

    // Fetch the page of contacts
    const results = await this.db
      .prepare(
        `SELECT id, tenant_id, full_name, phone_number, email, metadata, created_at, updated_at
         FROM contacts
         WHERE tenant_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
      .bind(tenantId, effectivePageSize, offset)
      .all<Contact>();

    const data = results.results ?? [];

    return {
      data,
      page: effectivePage,
      pageSize: effectivePageSize,
      total,
      hasMore: offset + data.length < total,
    };
  }

  /**
   * Get a single contact by ID, scoped to the tenant.
   * Returns null if the contact doesn't exist or doesn't belong to the tenant.
   *
   * @param tenantId - The tenant to scope the query to
   * @param contactId - The contact ID to look up
   * @returns The contact or null if not found/not owned
   */
  async getById(tenantId: string, contactId: string): Promise<Contact | null> {
    const result = await this.db
      .prepare(
        `SELECT id, tenant_id, full_name, phone_number, email, metadata, created_at, updated_at
         FROM contacts
         WHERE id = ? AND tenant_id = ?`
      )
      .bind(contactId, tenantId)
      .first<Contact>();

    return result ?? null;
  }

  /**
   * Update an existing contact.
   * Validates input, performs UPDATE with tenant_id check, and sets updated_at timestamp.
   *
   * @param tenantId - The tenant to scope the update to
   * @param contactId - The contact ID to update
   * @param input - The fields to update
   * @returns The updated contact record
   * @throws Error if validation fails or contact not found
   */
  async update(
    tenantId: string,
    contactId: string,
    input: UpdateContactInput
  ): Promise<Contact> {
    // Validate input
    const validation = validateUpdateContact(input);
    if (!validation.valid) {
      const errorMessages = validation.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
      throw new Error(`Validation failed: ${errorMessages}`);
    }

    // Fetch existing contact to ensure it exists and belongs to tenant
    const existing = await this.getById(tenantId, contactId);
    if (!existing) {
      throw new Error('Contact not found');
    }

    // Build dynamic update fields
    const now = new Date().toISOString();
    const updates: string[] = [];
    const values: (string | null)[] = [];

    if (input.full_name !== undefined) {
      updates.push('full_name = ?');
      values.push(input.full_name);
    }

    if (input.phone_number !== undefined) {
      updates.push('phone_number = ?');
      values.push(input.phone_number || null);
    }

    if (input.email !== undefined) {
      updates.push('email = ?');
      values.push(input.email || null);
    }

    if (input.metadata !== undefined) {
      updates.push('metadata = ?');
      values.push(input.metadata ? JSON.stringify(input.metadata) : null);
    }

    // Always update the timestamp
    updates.push('updated_at = ?');
    values.push(now);

    await this.db
      .prepare(
        `UPDATE contacts SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`
      )
      .bind(...values, contactId, tenantId)
      .run();

    // Return the merged contact (existing + updates)
    return {
      ...existing,
      full_name: input.full_name !== undefined ? input.full_name : existing.full_name,
      phone_number: input.phone_number !== undefined ? (input.phone_number || null) : existing.phone_number,
      email: input.email !== undefined ? (input.email || null) : existing.email,
      metadata: input.metadata !== undefined
        ? (input.metadata ? JSON.stringify(input.metadata) : null)
        : existing.metadata,
      updated_at: now,
    };
  }

  /**
   * Delete a contact by ID, scoped to the tenant.
   * Only deletes if the contact belongs to the specified tenant.
   *
   * @param tenantId - The tenant to scope the delete to
   * @param contactId - The contact ID to delete
   * @throws Error if contact not found or doesn't belong to tenant
   */
  async delete(tenantId: string, contactId: string): Promise<void> {
    const result = await this.db
      .prepare('DELETE FROM contacts WHERE id = ? AND tenant_id = ?')
      .bind(contactId, tenantId)
      .run();

    if ((result.meta?.changes ?? 0) === 0) {
      throw new Error('Contact not found');
    }
  }
}

// ============================================================================
// Standalone function wrappers for route consumption
// These wrap the class methods for convenience in route handlers.
// ============================================================================

/**
 * Creates a new contact for a tenant.
 */
export async function createContact(
  db: D1Database,
  tenantId: string,
  input: CreateContactInput
): Promise<Contact> {
  const service = new ContactService(db);
  return service.create(tenantId, input);
}

/**
 * Lists contacts for a tenant with pagination.
 */
export async function listContacts(
  db: D1Database,
  tenantId: string,
  page: number = 1,
  pageSize: number = DEFAULT_PAGE_SIZE
): Promise<PaginatedResult<Contact>> {
  const service = new ContactService(db);
  return service.list(tenantId, page, pageSize);
}

/**
 * Gets a single contact by ID, scoped to the tenant.
 * Returns null if not found or not belonging to tenant.
 */
export async function getContactById(
  db: D1Database,
  tenantId: string,
  contactId: string
): Promise<Contact | null> {
  const service = new ContactService(db);
  return service.getById(tenantId, contactId);
}

/**
 * Updates an existing contact. Returns null if not found.
 */
export async function updateContact(
  db: D1Database,
  tenantId: string,
  contactId: string,
  input: UpdateContactInput
): Promise<Contact | null> {
  const service = new ContactService(db);
  try {
    return await service.update(tenantId, contactId, input);
  } catch (e: unknown) {
    if (e instanceof Error && e.message === 'Contact not found') {
      return null;
    }
    throw e;
  }
}

/**
 * Deletes a contact. Returns true if deleted, false if not found.
 */
export async function deleteContact(
  db: D1Database,
  tenantId: string,
  contactId: string
): Promise<boolean> {
  const service = new ContactService(db);
  try {
    await service.delete(tenantId, contactId);
    return true;
  } catch (e: unknown) {
    if (e instanceof Error && e.message === 'Contact not found') {
      return false;
    }
    throw e;
  }
}
