/**
 * Support Ticket Service for AI Sales Agent.
 * Manages support ticket lifecycle including creation, assignment, status updates,
 * and tenant-scoped querying with filtering and pagination.
 *
 * Requirements: 12.1, 12.2, 12.3
 */

import type { SupportTicket } from '../../types/ai';

/**
 * SupportTicketService provides tenant-scoped support ticket management.
 * All operations enforce tenant isolation.
 */
export class SupportTicketService {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Create a new support ticket.
   *
   * @param tenantId - The tenant creating the ticket
   * @param contactId - The contact associated with the ticket
   * @param type - Ticket type (billing, technical, product, general)
   * @param description - Ticket description
   * @param priority - Ticket priority (low, medium, high, critical)
   * @returns The created SupportTicket record
   */
  async createTicket(
    tenantId: string,
    contactId: string,
    type: 'billing' | 'technical' | 'product' | 'general',
    description: string,
    priority: 'low' | 'medium' | 'high' | 'critical'
  ): Promise<SupportTicket> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const ticket: SupportTicket = {
      id,
      tenant_id: tenantId,
      contact_id: contactId,
      type,
      description,
      priority,
      status: 'open',
      assigned_to: null,
      resolution: null,
      conversation_turns: 0,
      created_at: now,
      updated_at: now,
    };

    await this.db
      .prepare(
        `INSERT INTO support_tickets (id, tenant_id, contact_id, type, description, priority, status, assigned_to, resolution, conversation_turns, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        ticket.id,
        ticket.tenant_id,
        ticket.contact_id,
        ticket.type,
        ticket.description,
        ticket.priority,
        ticket.status,
        ticket.assigned_to,
        ticket.resolution,
        ticket.conversation_turns,
        ticket.created_at,
        ticket.updated_at
      )
      .run();

    return ticket;
  }

  /**
   * Update ticket status with optional resolution text.
   *
   * @param tenantId - The tenant owning the ticket
   * @param ticketId - The ticket to update
   * @param status - New status value
   * @param resolution - Optional resolution text (typically set when resolving/closing)
   * @returns The updated SupportTicket record
   * @throws Error if ticket not found
   */
  async updateStatus(
    tenantId: string,
    ticketId: string,
    status: 'open' | 'in_progress' | 'escalated' | 'resolved' | 'closed',
    resolution?: string
  ): Promise<SupportTicket> {
    const now = new Date().toISOString();

    if (resolution) {
      await this.db
        .prepare(
          `UPDATE support_tickets SET status = ?, resolution = ?, updated_at = ?
           WHERE id = ? AND tenant_id = ?`
        )
        .bind(status, resolution, now, ticketId, tenantId)
        .run();
    } else {
      await this.db
        .prepare(
          `UPDATE support_tickets SET status = ?, updated_at = ?
           WHERE id = ? AND tenant_id = ?`
        )
        .bind(status, now, ticketId, tenantId)
        .run();
    }

    const updated = await this.db
      .prepare('SELECT * FROM support_tickets WHERE id = ? AND tenant_id = ?')
      .bind(ticketId, tenantId)
      .first<SupportTicket>();

    if (!updated) {
      throw new Error(`Ticket ${ticketId} not found for tenant ${tenantId}`);
    }

    return updated;
  }

  /**
   * List tickets for a tenant with optional filters and pagination.
   *
   * @param tenantId - The tenant to list tickets for
   * @param filters - Optional filters for status, priority, type, and pagination
   * @returns Object with tickets array and total count
   */
  async listTickets(
    tenantId: string,
    filters?: {
      status?: string;
      priority?: string;
      type?: string;
      contact_id?: string;
      assigned_to?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<{ tickets: SupportTicket[]; total: number }> {
    const limit = filters?.limit ?? 20;
    const offset = filters?.offset ?? 0;

    let whereClause = 'WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (filters?.status) {
      whereClause += ' AND status = ?';
      params.push(filters.status);
    }

    if (filters?.priority) {
      whereClause += ' AND priority = ?';
      params.push(filters.priority);
    }

    if (filters?.type) {
      whereClause += ' AND type = ?';
      params.push(filters.type);
    }

    if (filters?.contact_id) {
      whereClause += ' AND contact_id = ?';
      params.push(filters.contact_id);
    }

    if (filters?.assigned_to) {
      whereClause += ' AND assigned_to = ?';
      params.push(filters.assigned_to);
    }

    // Get total count
    const countResult = await this.db
      .prepare(`SELECT COUNT(*) as count FROM support_tickets ${whereClause}`)
      .bind(...params)
      .first<{ count: number }>();

    const total = countResult?.count ?? 0;

    // Get paginated results
    const results = await this.db
      .prepare(
        `SELECT * FROM support_tickets ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .bind(...params, limit, offset)
      .all<SupportTicket>();

    return {
      tickets: results.results ?? [],
      total,
    };
  }

  /**
   * Assign a ticket to a user/staff member.
   *
   * @param tenantId - The tenant owning the ticket
   * @param ticketId - The ticket to assign
   * @param assignedTo - The user/staff ID to assign to
   * @returns The updated SupportTicket record
   * @throws Error if ticket not found
   */
  async assignTicket(
    tenantId: string,
    ticketId: string,
    assignedTo: string
  ): Promise<SupportTicket> {
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `UPDATE support_tickets SET assigned_to = ?, status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END, updated_at = ?
         WHERE id = ? AND tenant_id = ?`
      )
      .bind(assignedTo, now, ticketId, tenantId)
      .run();

    const updated = await this.db
      .prepare('SELECT * FROM support_tickets WHERE id = ? AND tenant_id = ?')
      .bind(ticketId, tenantId)
      .first<SupportTicket>();

    if (!updated) {
      throw new Error(`Ticket ${ticketId} not found for tenant ${tenantId}`);
    }

    return updated;
  }

  /**
   * Get a single ticket by ID (tenant-scoped).
   *
   * @param tenantId - The tenant owning the ticket
   * @param ticketId - The ticket ID to retrieve
   * @returns The SupportTicket record or null if not found
   */
  async getById(tenantId: string, ticketId: string): Promise<SupportTicket | null> {
    const result = await this.db
      .prepare('SELECT * FROM support_tickets WHERE id = ? AND tenant_id = ?')
      .bind(ticketId, tenantId)
      .first<SupportTicket>();

    return result ?? null;
  }
}
