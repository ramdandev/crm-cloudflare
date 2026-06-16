/**
 * Escalation Service for Human Escalation & Dynamic Knowledge system.
 * Handles staff escalation via WhatsApp, staff response routing,
 * dynamic knowledge base learning from staff answers, and timeout management.
 *
 * Key behaviors:
 * - Escalates customer questions to designated staff via WhatsApp (GoWa)
 * - Routes staff replies back using correlation_id tracking
 * - Auto-creates KB entries from staff responses (entry_type='learned', source='escalation')
 * - Supports staff command format: #KB: <title> | <content> | <category>
 * - Handles escalation timeouts (30 min default) with ticket creation
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8
 */

import type { EscalationStaff, PendingEscalation } from '../../types';

/** Default escalation timeout in minutes */
const DEFAULT_TIMEOUT_MINUTES = 30;

/** KV key prefix for pending escalation tracking */
const KV_ESCALATION_PREFIX = 'escalation_pending:';

/** KV TTL for escalation state (30 minutes in seconds) */
const KV_ESCALATION_TTL = 1800;

/**
 * Input for configuring staff members for escalation.
 */
export interface ConfigureStaffInput {
  name: string;
  phone_number: string;
  priority_order: number;
  specialties?: string[];
}

/**
 * State stored in KV for pending escalation tracking.
 * Used by the webhook handler to route staff replies.
 */
export interface EscalationKVState {
  escalation_id: string;
  tenant_id: string;
  contact_id: string;
  staff_id: string;
  staff_phone: string;
  question: string;
  created_at: string;
}

/**
 * EscalationService manages the full lifecycle of staff escalations:
 * from initial escalation through staff response to knowledge base learning.
 * All operations are tenant-scoped for data isolation.
 */
export class EscalationService {
  private db: D1Database;
  private kv: KVNamespace;

  constructor(db: D1Database, kv: KVNamespace) {
    this.db = db;
    this.kv = kv;
  }

  /**
   * Escalate a question to designated staff via WhatsApp.
   *
   * Flow:
   * 1. Get highest priority active staff from `escalation_staff` table
   * 2. Generate a unique `correlation_id` (e.g., `esc-{uuid}`)
   * 3. Send a natural WhatsApp message to staff via GoWa
   * 4. Store in `pending_escalations` with status='pending', timeout_at = now + 30 minutes
   * 5. Store correlation_id in KV for webhook routing
   * 6. Return the PendingEscalation record
   *
   * @param tenantId - The tenant initiating the escalation
   * @param contactId - The customer contact being escalated for
   * @param question - The customer's question that needs staff help
   * @param contextSummary - Summary of the conversation context
   * @param gowaBaseUrl - Go-Wa gateway base URL
   * @param gowaApiKey - Go-Wa API key for authentication
   * @returns The created PendingEscalation record
   * @throws Error if no active staff configured for tenant
   */
  async escalateToStaff(
    tenantId: string,
    contactId: string,
    question: string,
    contextSummary: string,
    gowaBaseUrl: string,
    gowaApiKey: string
  ): Promise<PendingEscalation> {
    // Step 1: Get highest priority active staff
    const staff = await this.db
      .prepare(
        `SELECT id, tenant_id, name, phone_number, priority_order, specialties, active
         FROM escalation_staff
         WHERE tenant_id = ? AND active = 1
         ORDER BY priority_order ASC
         LIMIT 1`
      )
      .bind(tenantId)
      .first<EscalationStaff>();

    if (!staff) {
      throw new Error('No active escalation staff configured for this tenant');
    }

    // Step 2: Generate unique correlation_id
    const correlationId = `esc-${crypto.randomUUID()}`;
    const escalationId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Calculate timeout (30 minutes from now)
    const timeoutAt = new Date(Date.now() + DEFAULT_TIMEOUT_MINUTES * 60 * 1000).toISOString();

    // Step 3: Send natural WhatsApp message to staff
    const staffMessage = `Hai ${staff.name}, ada customer yang bertanya: '${question}'. Konteks: ${contextSummary}. Bisa tolong bantu jawab? (Reply pesan ini langsung ya)`;

    await this.sendWhatsAppMessage(
      gowaBaseUrl,
      gowaApiKey,
      staff.phone_number,
      staffMessage
    );

    // Step 4: Store in pending_escalations table
    await this.db
      .prepare(
        `INSERT INTO pending_escalations (id, tenant_id, contact_id, staff_id, correlation_id, question, context_summary, status, staff_response, created_at, responded_at, timeout_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)`
      )
      .bind(
        escalationId,
        tenantId,
        contactId,
        staff.id,
        correlationId,
        question,
        contextSummary,
        now,
        timeoutAt
      )
      .run();

    // Step 5: Store correlation_id in KV for webhook routing
    const kvState: EscalationKVState = {
      escalation_id: escalationId,
      tenant_id: tenantId,
      contact_id: contactId,
      staff_id: staff.id,
      staff_phone: staff.phone_number,
      question,
      created_at: now,
    };

    await this.kv.put(
      `${KV_ESCALATION_PREFIX}${correlationId}`,
      JSON.stringify(kvState),
      { expirationTtl: KV_ESCALATION_TTL }
    );

    // Step 6: Return the PendingEscalation record
    return {
      id: escalationId,
      tenant_id: tenantId,
      contact_id: contactId,
      staff_id: staff.id,
      correlation_id: correlationId,
      question,
      context_summary: contextSummary,
      status: 'pending',
      staff_response: null,
      created_at: now,
      responded_at: null,
      timeout_at: timeoutAt,
    };
  }

  /**
   * Handle a staff response to a pending escalation.
   * Called when the webhook detects a message from a staff phone number
   * that correlates with a pending escalation.
   *
   * Flow:
   * 1. Look up pending_escalation by correlation_id
   * 2. Update status to 'answered', set staff_response and responded_at
   * 3. Auto-create KB entry from the answer
   * 4. Remove KV entry
   * 5. Return the data needed to compose reply to customer
   *
   * @param correlationId - The correlation_id linking the staff reply to the escalation
   * @param response - The staff member's response text
   * @returns Object with tenantId, contactId, and answer for composing customer reply; or null if not found
   */
  async handleStaffResponse(
    correlationId: string,
    response: string
  ): Promise<{ tenantId: string; contactId: string; answer: string } | null> {
    // Step 1: Look up pending_escalation by correlation_id
    const escalation = await this.db
      .prepare(
        `SELECT id, tenant_id, contact_id, staff_id, correlation_id, question, context_summary, status, staff_response, created_at, responded_at, timeout_at
         FROM pending_escalations
         WHERE correlation_id = ? AND status = 'pending'`
      )
      .bind(correlationId)
      .first<PendingEscalation>();

    if (!escalation) {
      return null;
    }

    const now = new Date().toISOString();

    // Step 2: Update status to 'answered'
    await this.db
      .prepare(
        `UPDATE pending_escalations
         SET status = 'answered', staff_response = ?, responded_at = ?
         WHERE id = ?`
      )
      .bind(response, now, escalation.id)
      .run();

    // Step 3: Auto-create KB entry from the answer
    await this.addKnowledgeFromResponse(
      escalation.tenant_id,
      escalation.question,
      response,
      'escalation_learned'
    );

    // Step 4: Remove KV entry
    await this.kv.delete(`${KV_ESCALATION_PREFIX}${correlationId}`);

    // Step 5: Return data for composing customer reply
    return {
      tenantId: escalation.tenant_id,
      contactId: escalation.contact_id,
      answer: response,
    };
  }

  /**
   * Auto-create a KB entry from a staff response.
   * Creates entries with entry_type='learned' and source='escalation'
   * to distinguish them from manually created entries.
   *
   * @param tenantId - The tenant to create the KB entry for
   * @param question - The original customer question (used as title)
   * @param answer - The staff answer (used as content)
   * @param category - The category to file the entry under
   */
  async addKnowledgeFromResponse(
    tenantId: string,
    question: string,
    answer: string,
    category: string
  ): Promise<void> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `INSERT INTO knowledge_base (id, tenant_id, title, content, category, tags, embedding, file_r2_key, entry_type, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 'learned', 'escalation', ?, ?)`
      )
      .bind(id, tenantId, question, answer, category, now, now)
      .run();
  }

  /**
   * Parse a staff command message in the format:
   * #KB: <title> | <content> | <category>
   *
   * Staff can use this format to directly add entries to the knowledge base.
   *
   * @param message - The raw message text from staff
   * @returns Parsed command object with title, content, category; or null if format doesn't match
   */
  parseStaffCommand(message: string): { title: string; content: string; category: string } | null {
    // Match format: #KB: <title> | <content> | <category>
    const prefix = '#KB:';
    const trimmed = message.trim();

    if (!trimmed.startsWith(prefix)) {
      return null;
    }

    // Remove the prefix and split by pipe
    const body = trimmed.slice(prefix.length).trim();
    const parts = body.split('|').map((part) => part.trim());

    // Must have exactly 3 parts: title, content, category
    if (parts.length !== 3) {
      return null;
    }

    const [title, content, category] = parts;

    // Validate all parts are non-empty
    if (!title || !content || !category) {
      return null;
    }

    return { title, content, category };
  }

  /**
   * Check for timed-out escalations and create support tickets.
   * Queries pending escalations past their timeout_at and:
   * 1. Updates status to 'timeout'
   * 2. Creates a support ticket for each timed-out escalation
   * 3. Returns count of timed-out escalations processed
   *
   * @param tenantId - The tenant to check timeouts for
   * @returns Number of timed-out escalations processed
   */
  async checkTimeouts(tenantId: string): Promise<number> {
    const now = new Date().toISOString();

    // Query pending escalations past their timeout
    const timedOut = await this.db
      .prepare(
        `SELECT id, tenant_id, contact_id, staff_id, correlation_id, question, context_summary, status, staff_response, created_at, responded_at, timeout_at
         FROM pending_escalations
         WHERE tenant_id = ? AND status = 'pending' AND timeout_at < ?`
      )
      .bind(tenantId, now)
      .all<PendingEscalation>();

    const escalations = timedOut.results ?? [];

    if (escalations.length === 0) {
      return 0;
    }

    // Process each timed-out escalation
    for (const escalation of escalations) {
      // Update status to 'timeout'
      await this.db
        .prepare(
          `UPDATE pending_escalations SET status = 'timeout' WHERE id = ?`
        )
        .bind(escalation.id)
        .run();

      // Create a support ticket for the timed-out escalation
      const ticketId = crypto.randomUUID();
      await this.db
        .prepare(
          `INSERT INTO support_tickets (id, tenant_id, contact_id, type, description, priority, status, assigned_to, resolution, conversation_turns, created_at, updated_at)
           VALUES (?, ?, ?, 'general', ?, 'medium', 'open', NULL, NULL, 0, ?, ?)`
        )
        .bind(
          ticketId,
          escalation.tenant_id,
          escalation.contact_id,
          `Escalation timed out: ${escalation.question}`,
          now,
          now
        )
        .run();

      // Remove KV entry for the timed-out escalation
      await this.kv.delete(`${KV_ESCALATION_PREFIX}${escalation.correlation_id}`);
    }

    return escalations.length;
  }

  /**
   * Configure staff contacts for a tenant.
   * Replaces all existing staff with the provided list.
   *
   * @param tenantId - The tenant to configure staff for
   * @param staff - Array of staff members to configure
   * @returns The configured staff records
   */
  async configureStaff(
    tenantId: string,
    staff: ConfigureStaffInput[]
  ): Promise<EscalationStaff[]> {
    // Deactivate all existing staff for this tenant
    await this.db
      .prepare(
        `UPDATE escalation_staff SET active = 0 WHERE tenant_id = ?`
      )
      .bind(tenantId)
      .run();

    const results: EscalationStaff[] = [];

    // Insert/activate new staff entries
    for (const member of staff) {
      const id = crypto.randomUUID();
      const specialtiesJson = member.specialties ? JSON.stringify(member.specialties) : null;

      await this.db
        .prepare(
          `INSERT INTO escalation_staff (id, tenant_id, name, phone_number, priority_order, specialties, active)
           VALUES (?, ?, ?, ?, ?, ?, 1)`
        )
        .bind(
          id,
          tenantId,
          member.name,
          member.phone_number,
          member.priority_order,
          specialtiesJson
        )
        .run();

      results.push({
        id,
        tenant_id: tenantId,
        name: member.name,
        phone_number: member.phone_number,
        priority_order: member.priority_order,
        specialties: specialtiesJson,
        active: 1,
      });
    }

    return results;
  }

  /**
   * Get all active staff for a tenant, ordered by priority.
   *
   * @param tenantId - The tenant to get staff for
   * @returns Array of active escalation staff ordered by priority
   */
  async getStaff(tenantId: string): Promise<EscalationStaff[]> {
    const result = await this.db
      .prepare(
        `SELECT id, tenant_id, name, phone_number, priority_order, specialties, active
         FROM escalation_staff
         WHERE tenant_id = ? AND active = 1
         ORDER BY priority_order ASC`
      )
      .bind(tenantId)
      .all<EscalationStaff>();

    return result.results ?? [];
  }

  /**
   * Send a WhatsApp message via the Go-Wa gateway.
   * Uses the same API format as GoWaService for consistency.
   *
   * @param gowaBaseUrl - Go-Wa gateway base URL
   * @param gowaApiKey - Go-Wa API key
   * @param recipient - The recipient phone number
   * @param message - The message content
   */
  private async sendWhatsAppMessage(
    gowaBaseUrl: string,
    gowaApiKey: string,
    recipient: string,
    message: string
  ): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(`${gowaBaseUrl}/send/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${gowaApiKey}`,
        },
        body: JSON.stringify({
          phone: recipient,
          message,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Go-Wa API returned status ${response.status}`);
      }
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Go-Wa gateway timeout sending escalation message');
      }

      throw error;
    }
  }
}

// ============================================================================
// Standalone function wrappers for route consumption
// ============================================================================

/**
 * Escalate a question to staff via WhatsApp.
 */
export async function escalateToStaff(
  db: D1Database,
  kv: KVNamespace,
  tenantId: string,
  contactId: string,
  question: string,
  contextSummary: string,
  gowaBaseUrl: string,
  gowaApiKey: string
): Promise<PendingEscalation> {
  const service = new EscalationService(db, kv);
  return service.escalateToStaff(tenantId, contactId, question, contextSummary, gowaBaseUrl, gowaApiKey);
}

/**
 * Handle a staff response to a pending escalation.
 */
export async function handleStaffResponse(
  db: D1Database,
  kv: KVNamespace,
  correlationId: string,
  response: string
): Promise<{ tenantId: string; contactId: string; answer: string } | null> {
  const service = new EscalationService(db, kv);
  return service.handleStaffResponse(correlationId, response);
}

/**
 * Parse a staff KB command message.
 */
export function parseStaffCommand(
  message: string
): { title: string; content: string; category: string } | null {
  const service = new EscalationService(null as unknown as D1Database, null as unknown as KVNamespace);
  return service.parseStaffCommand(message);
}

/**
 * Check for timed-out escalations and create tickets.
 */
export async function checkEscalationTimeouts(
  db: D1Database,
  kv: KVNamespace,
  tenantId: string
): Promise<number> {
  const service = new EscalationService(db, kv);
  return service.checkTimeouts(tenantId);
}

/**
 * Configure escalation staff for a tenant.
 */
export async function configureEscalationStaff(
  db: D1Database,
  kv: KVNamespace,
  tenantId: string,
  staff: ConfigureStaffInput[]
): Promise<EscalationStaff[]> {
  const service = new EscalationService(db, kv);
  return service.configureStaff(tenantId, staff);
}

/**
 * Get active escalation staff for a tenant.
 */
export async function getEscalationStaff(
  db: D1Database,
  kv: KVNamespace,
  tenantId: string
): Promise<EscalationStaff[]> {
  const service = new EscalationService(db, kv);
  return service.getStaff(tenantId);
}
