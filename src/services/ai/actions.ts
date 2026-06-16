/**
 * Action Trigger Service for AI Sales Agent.
 * Manages a per-tenant registry of configurable actions and executes them
 * with validated parameters.
 *
 * Supported action types:
 * - send_invoice: Creates payment link via BillingService
 * - create_appointment: Books appointment record in D1
 * - create_ticket: Creates support ticket in D1
 * - update_pipeline: Updates sales pipeline stage
 * - notify_staff: Sends WhatsApp message to staff via GoWaService
 * - custom_webhook: POST to configured webhook URL with params as body
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
 */

import type { ActionTrigger, ActionExecutionResult } from '../../types/ai';
import type { Bindings } from '../../types/bindings';
import type { TransactionType } from '../../types';
import { BillingService } from '../billing';
import { GoWaService } from '../gowa';

/**
 * ActionTriggerService provides action registration, validation, and execution.
 * All operations are tenant-scoped for data isolation.
 */
export class ActionTriggerService {
  private db: D1Database;
  private env: Bindings;

  constructor(db: D1Database, env: Bindings) {
    this.db = db;
    this.env = env;
  }

  /**
   * Register or update an action for a tenant.
   * If an action with the same action_type already exists for the tenant, it is updated.
   * Otherwise, a new action is created.
   *
   * @param tenantId - The tenant registering the action
   * @param action - Action configuration
   * @returns The created/updated ActionTrigger record
   */
  async registerAction(
    tenantId: string,
    action: {
      action_type: string;
      action_name: string;
      config: Record<string, unknown>;
      parameter_schema: Record<string, unknown>;
    }
  ): Promise<ActionTrigger> {
    const now = new Date().toISOString();

    // Check if an action with this type already exists for the tenant
    const existing = await this.db
      .prepare(
        'SELECT id FROM action_triggers WHERE tenant_id = ? AND action_type = ?'
      )
      .bind(tenantId, action.action_type)
      .first<{ id: string }>();

    if (existing) {
      // Update existing action
      await this.db
        .prepare(
          `UPDATE action_triggers
           SET action_name = ?, config = ?, parameter_schema = ?, active = 1, updated_at = ?
           WHERE id = ? AND tenant_id = ?`
        )
        .bind(
          action.action_name,
          JSON.stringify(action.config),
          JSON.stringify(action.parameter_schema),
          now,
          existing.id,
          tenantId
        )
        .run();

      const updated = await this.db
        .prepare('SELECT * FROM action_triggers WHERE id = ? AND tenant_id = ?')
        .bind(existing.id, tenantId)
        .first<ActionTrigger>();

      return updated!;
    }

    // Create new action
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO action_triggers (id, tenant_id, action_type, action_name, config, parameter_schema, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .bind(
        id,
        tenantId,
        action.action_type,
        action.action_name,
        JSON.stringify(action.config),
        JSON.stringify(action.parameter_schema),
        now,
        now
      )
      .run();

    const created = await this.db
      .prepare('SELECT * FROM action_triggers WHERE id = ? AND tenant_id = ?')
      .bind(id, tenantId)
      .first<ActionTrigger>();

    return created!;
  }

  /**
   * Execute an action with validated parameters.
   * Looks up the registered action, validates params against its schema,
   * then dispatches to the appropriate executor.
   *
   * @param tenantId - The tenant executing the action
   * @param actionType - The action type to execute
   * @param params - Parameters for the action
   * @returns ActionExecutionResult with success/failure and result data
   */
  async executeAction(
    tenantId: string,
    actionType: string,
    params: Record<string, unknown>
  ): Promise<ActionExecutionResult> {
    // Look up the registered action for this tenant
    const action = await this.db
      .prepare(
        'SELECT * FROM action_triggers WHERE tenant_id = ? AND action_type = ? AND active = 1'
      )
      .bind(tenantId, actionType)
      .first<ActionTrigger>();

    if (!action) {
      return {
        success: false,
        action_type: actionType,
        result_data: {},
        error: `Action type '${actionType}' is not registered or inactive for this tenant`,
      };
    }

    // Parse the parameter schema and validate params
    let schema: Record<string, unknown>;
    try {
      schema = JSON.parse(action.parameter_schema);
    } catch {
      return {
        success: false,
        action_type: actionType,
        result_data: {},
        error: 'Invalid parameter schema configuration',
      };
    }

    const validation = this.validateParams(params, schema);
    if (!validation.valid) {
      return {
        success: false,
        action_type: actionType,
        result_data: {},
        error: `Parameter validation failed: ${validation.error}`,
      };
    }

    // Dispatch to the appropriate executor
    try {
      const result = await this.dispatchAction(tenantId, actionType, params, action);

      // Emit webhook notification on success if configured
      const config = JSON.parse(action.config) as Record<string, unknown>;
      if (config.webhook_url) {
        await this.emitWebhookNotification(
          config.webhook_url as string,
          tenantId,
          actionType,
          params,
          result
        );
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown execution error';
      return {
        success: false,
        action_type: actionType,
        result_data: {},
        error: errorMessage,
      };
    }
  }

  /**
   * Validate parameters against a simple JSON Schema.
   * Checks required fields exist and have the correct types.
   *
   * Supports schema format:
   * {
   *   required: ["field1", "field2"],
   *   properties: {
   *     field1: { type: "string" },
   *     field2: { type: "number" }
   *   }
   * }
   *
   * @param params - The parameters to validate
   * @param schema - The JSON schema to validate against
   * @returns Validation result with optional error message
   */
  validateParams(
    params: Record<string, unknown>,
    schema: Record<string, unknown>
  ): { valid: boolean; error?: string } {
    // Check required fields
    const required = schema.required as string[] | undefined;
    if (required && Array.isArray(required)) {
      for (const field of required) {
        if (params[field] === undefined || params[field] === null) {
          return { valid: false, error: `Missing required field: ${field}` };
        }
      }
    }

    // Check property types if properties are defined
    const properties = schema.properties as Record<string, { type?: string }> | undefined;
    if (properties && typeof properties === 'object') {
      for (const [field, fieldSchema] of Object.entries(properties)) {
        const value = params[field];
        if (value === undefined || value === null) {
          // Skip type check for missing optional fields
          continue;
        }

        if (fieldSchema.type) {
          const expectedType = fieldSchema.type;
          const actualType = Array.isArray(value) ? 'array' : typeof value;

          if (expectedType === 'integer') {
            if (typeof value !== 'number' || !Number.isInteger(value)) {
              return {
                valid: false,
                error: `Field '${field}' must be an integer, got ${actualType}`,
              };
            }
          } else if (expectedType !== actualType) {
            return {
              valid: false,
              error: `Field '${field}' must be of type '${expectedType}', got '${actualType}'`,
            };
          }
        }
      }
    }

    return { valid: true };
  }

  /**
   * List all registered actions for a tenant.
   *
   * @param tenantId - The tenant to list actions for
   * @returns Array of ActionTrigger records
   */
  async listActions(tenantId: string): Promise<ActionTrigger[]> {
    const results = await this.db
      .prepare(
        'SELECT * FROM action_triggers WHERE tenant_id = ? ORDER BY action_type ASC'
      )
      .bind(tenantId)
      .all<ActionTrigger>();

    return results.results ?? [];
  }

  /**
   * Dispatch action execution to the appropriate handler based on action type.
   */
  private async dispatchAction(
    tenantId: string,
    actionType: string,
    params: Record<string, unknown>,
    action: ActionTrigger
  ): Promise<ActionExecutionResult> {
    switch (actionType) {
      case 'send_invoice':
        return this.executeSendInvoice(tenantId, params);
      case 'create_appointment':
        return this.executeCreateAppointment(tenantId, params);
      case 'create_ticket':
        return this.executeCreateTicket(tenantId, params);
      case 'update_pipeline':
        return this.executeUpdatePipeline(tenantId, params);
      case 'notify_staff':
        return this.executeNotifyStaff(tenantId, params);
      case 'custom_webhook':
        return this.executeCustomWebhook(tenantId, params, action);
      default:
        return {
          success: false,
          action_type: actionType,
          result_data: {},
          error: `Unsupported action type: ${actionType}`,
        };
    }
  }

  /**
   * Execute send_invoice action.
   * Uses BillingService to create a payment link.
   *
   * Expected params: { amount, description, type?, contact_id? }
   */
  private async executeSendInvoice(
    tenantId: string,
    params: Record<string, unknown>
  ): Promise<ActionExecutionResult> {
    const billingService = new BillingService(
      this.db,
      this.env.IPAYMU_API_KEY,
      this.env.IPAYMU_VA,
      this.env.IPAYMU_SECRET
    );

    const paymentType = (params.type as TransactionType) || 'quota_purchase';

    const paymentResult = await billingService.createPaymentLink(tenantId, {
      tenant_id: tenantId,
      amount: params.amount as number,
      description: (params.description as string) || 'Invoice from AI Agent',
      type: paymentType,
    });

    return {
      success: true,
      action_type: 'send_invoice',
      result_data: {
        payment_url: paymentResult.payment_url,
        transaction_id: paymentResult.transaction_id,
        expires_at: paymentResult.expires_at,
      },
    };
  }

  /**
   * Execute create_appointment action.
   * Creates an appointment record in D1.
   *
   * Expected params: { date, time_start, duration, contact_id }
   */
  private async executeCreateAppointment(
    tenantId: string,
    params: Record<string, unknown>
  ): Promise<ActionExecutionResult> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const date = params.date as string;
    const timeStart = params.time_start as string;
    const duration = params.duration as number;

    // Calculate time_end from time_start + duration
    const timeParts = timeStart.split(':');
    const hours = parseInt(timeParts[0] ?? '0', 10);
    const minutes = parseInt(timeParts[1] ?? '0', 10);
    const startMinutes = hours * 60 + minutes;
    const endMinutes = startMinutes + duration;
    const endHours = Math.floor(endMinutes / 60);
    const endMins = endMinutes % 60;
    const timeEnd = `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}`;

    await this.db
      .prepare(
        `INSERT INTO appointments (id, tenant_id, contact_id, date, time_start, time_end, duration_minutes, status, notes, reminder_24h_sent, reminder_1h_sent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, 0, 0, ?, ?)`
      )
      .bind(
        id,
        tenantId,
        params.contact_id as string,
        date,
        timeStart,
        timeEnd,
        duration,
        (params.notes as string) || null,
        now,
        now
      )
      .run();

    return {
      success: true,
      action_type: 'create_appointment',
      result_data: {
        appointment_id: id,
        date,
        time_start: timeStart,
        time_end: timeEnd,
        duration_minutes: duration,
        status: 'confirmed',
      },
    };
  }

  /**
   * Execute create_ticket action.
   * Creates a support ticket in D1.
   *
   * Expected params: { type, description, priority, contact_id? }
   */
  private async executeCreateTicket(
    tenantId: string,
    params: Record<string, unknown>
  ): Promise<ActionExecutionResult> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `INSERT INTO support_tickets (id, tenant_id, contact_id, type, description, priority, status, conversation_turns, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)`
      )
      .bind(
        id,
        tenantId,
        (params.contact_id as string) || '',
        params.type as string,
        params.description as string,
        params.priority as string,
        now,
        now
      )
      .run();

    return {
      success: true,
      action_type: 'create_ticket',
      result_data: {
        ticket_id: id,
        type: params.type as string,
        priority: params.priority as string,
        status: 'open',
      },
    };
  }

  /**
   * Execute update_pipeline action.
   * Updates the sales pipeline stage for a contact.
   *
   * Expected params: { contact_id, stage }
   */
  private async executeUpdatePipeline(
    tenantId: string,
    params: Record<string, unknown>
  ): Promise<ActionExecutionResult> {
    const contactId = params.contact_id as string;
    const stage = params.stage as string;
    const now = new Date().toISOString();

    // Check if pipeline entry exists for this contact
    const existing = await this.db
      .prepare(
        'SELECT id, stage FROM sales_pipeline WHERE tenant_id = ? AND contact_id = ?'
      )
      .bind(tenantId, contactId)
      .first<{ id: string; stage: string }>();

    if (existing) {
      // Update existing pipeline entry
      const previousStage = existing.stage;
      await this.db
        .prepare(
          'UPDATE sales_pipeline SET stage = ?, updated_at = ? WHERE id = ? AND tenant_id = ?'
        )
        .bind(stage, now, existing.id, tenantId)
        .run();

      return {
        success: true,
        action_type: 'update_pipeline',
        result_data: {
          pipeline_id: existing.id,
          contact_id: contactId,
          previous_stage: previousStage,
          new_stage: stage,
        },
      };
    }

    // Create new pipeline entry
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO sales_pipeline (id, tenant_id, contact_id, stage, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(id, tenantId, contactId, stage, now, now)
      .run();

    return {
      success: true,
      action_type: 'update_pipeline',
      result_data: {
        pipeline_id: id,
        contact_id: contactId,
        previous_stage: null,
        new_stage: stage,
      },
    };
  }

  /**
   * Execute notify_staff action.
   * Sends a WhatsApp message to staff via GoWaService.
   *
   * Expected params: { staff_phone, message }
   */
  private async executeNotifyStaff(
    tenantId: string,
    params: Record<string, unknown>
  ): Promise<ActionExecutionResult> {
    const gowaService = new GoWaService(
      this.db,
      this.env.GOWA_BASE_URL,
      this.env.GOWA_API_KEY
    );

    const staffPhone = params.staff_phone as string;
    const message = params.message as string;

    const sendResult = await gowaService.sendMessage(tenantId, staffPhone, message);

    if (sendResult.success) {
      return {
        success: true,
        action_type: 'notify_staff',
        result_data: {
          message_id: sendResult.message.id,
          staff_phone: staffPhone,
          delivery_status: sendResult.message.delivery_status,
        },
      };
    }

    return {
      success: false,
      action_type: 'notify_staff',
      result_data: {
        staff_phone: staffPhone,
      },
      error: sendResult.error,
    };
  }

  /**
   * Execute custom_webhook action.
   * POST to configured webhook URL with params as body.
   *
   * The webhook URL is stored in the action's config.
   * Expected params: any (sent as POST body)
   */
  private async executeCustomWebhook(
    tenantId: string,
    params: Record<string, unknown>,
    action: ActionTrigger
  ): Promise<ActionExecutionResult> {
    const config = JSON.parse(action.config) as Record<string, unknown>;
    const webhookUrl = config.webhook_url as string;

    if (!webhookUrl) {
      return {
        success: false,
        action_type: 'custom_webhook',
        result_data: {},
        error: 'No webhook_url configured for this action',
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': tenantId,
          'X-Action-Type': 'custom_webhook',
        },
        body: JSON.stringify({
          tenant_id: tenantId,
          action_type: 'custom_webhook',
          params,
          timestamp: new Date().toISOString(),
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          success: false,
          action_type: 'custom_webhook',
          result_data: {
            status_code: response.status,
            webhook_url: webhookUrl,
          },
          error: `Webhook returned HTTP ${response.status}`,
        };
      }

      let responseData: Record<string, unknown> = {};
      try {
        responseData = await response.json() as Record<string, unknown>;
      } catch {
        // Response is not JSON - that's fine
      }

      return {
        success: true,
        action_type: 'custom_webhook',
        result_data: {
          status_code: response.status,
          webhook_url: webhookUrl,
          response: responseData,
        },
      };
    } catch (error) {
      clearTimeout(timeoutId);
      const isTimeout =
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('abort'));
      const errorMessage = isTimeout
        ? 'Webhook request timed out after 10 seconds'
        : `Webhook request failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      return {
        success: false,
        action_type: 'custom_webhook',
        result_data: { webhook_url: webhookUrl },
        error: errorMessage,
      };
    }
  }

  /**
   * Emit webhook notification for completed action.
   * Non-blocking - errors are logged but don't affect the action result.
   */
  private async emitWebhookNotification(
    webhookUrl: string,
    tenantId: string,
    actionType: string,
    params: Record<string, unknown>,
    result: ActionExecutionResult
  ): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5_000);

      await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': tenantId,
          'X-Action-Type': actionType,
          'X-Webhook-Type': 'action_completion',
        },
        body: JSON.stringify({
          event: 'action_completed',
          tenant_id: tenantId,
          action_type: actionType,
          params,
          result: result.result_data,
          success: result.success,
          timestamp: new Date().toISOString(),
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
    } catch (error) {
      // Non-blocking - log and continue
      console.error(
        `[ActionTriggerService] Failed to emit webhook notification: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }
}
