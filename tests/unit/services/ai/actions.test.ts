/**
 * Unit tests for ActionTriggerService.
 * Validates Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockD1, createMockBindings } from '../../../helpers';
import { ActionTriggerService } from '../../../../src/services/ai/actions';
import type { Bindings } from '../../../../src/types/bindings';
import type { ActionTrigger } from '../../../../src/types/ai';

describe('ActionTriggerService', () => {
  let mockDb: ReturnType<typeof createMockD1>;
  let mockEnv: Bindings;
  let service: ActionTriggerService;

  beforeEach(() => {
    mockDb = createMockD1();
    mockEnv = createMockBindings({ DB: mockDb as unknown as D1Database });
    service = new ActionTriggerService(mockDb as unknown as D1Database, mockEnv);
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // validateParams
  // ==========================================================================

  describe('validateParams', () => {
    it('should pass validation when all required fields are present', () => {
      const params = { name: 'John', age: 30 };
      const schema = {
        required: ['name', 'age'],
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      };

      const result = service.validateParams(params, schema);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should fail validation when a required field is missing', () => {
      const params = { name: 'John' };
      const schema = {
        required: ['name', 'age'],
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      };

      const result = service.validateParams(params, schema);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Missing required field: age');
    });

    it('should fail validation when a required field is null', () => {
      const params = { name: null, age: 30 };
      const schema = {
        required: ['name', 'age'],
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      };

      const result = service.validateParams(params, schema);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Missing required field: name');
    });

    it('should fail validation when field type is incorrect', () => {
      const params = { name: 123, age: 30 };
      const schema = {
        required: ['name'],
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      };

      const result = service.validateParams(params, schema);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Field 'name' must be of type 'string'");
    });

    it('should fail validation for integer type when given a float', () => {
      const params = { count: 3.5 };
      const schema = {
        required: ['count'],
        properties: {
          count: { type: 'integer' },
        },
      };

      const result = service.validateParams(params, schema);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Field 'count' must be an integer");
    });

    it('should pass validation for integer type when given an integer', () => {
      const params = { count: 5 };
      const schema = {
        required: ['count'],
        properties: {
          count: { type: 'integer' },
        },
      };

      const result = service.validateParams(params, schema);
      expect(result.valid).toBe(true);
    });

    it('should skip type check for optional missing fields', () => {
      const params = { name: 'John' };
      const schema = {
        required: ['name'],
        properties: {
          name: { type: 'string' },
          optional_field: { type: 'number' },
        },
      };

      const result = service.validateParams(params, schema);
      expect(result.valid).toBe(true);
    });

    it('should pass validation with empty schema', () => {
      const params = { anything: 'goes' };
      const schema = {};

      const result = service.validateParams(params, schema);
      expect(result.valid).toBe(true);
    });

    it('should handle array type correctly', () => {
      const params = { items: [1, 2, 3] };
      const schema = {
        required: ['items'],
        properties: {
          items: { type: 'array' },
        },
      };

      const result = service.validateParams(params, schema);
      expect(result.valid).toBe(true);
    });

    it('should fail when array is expected but object is given', () => {
      const params = { items: { key: 'value' } };
      const schema = {
        required: ['items'],
        properties: {
          items: { type: 'array' },
        },
      };

      const result = service.validateParams(params, schema);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Field 'items' must be of type 'array'");
    });
  });

  // ==========================================================================
  // registerAction
  // ==========================================================================

  describe('registerAction', () => {
    it('should create a new action when none exists', async () => {
      const actionData = {
        action_type: 'send_invoice',
        action_name: 'Generate Invoice',
        config: { webhook_url: 'https://example.com/hook' },
        parameter_schema: {
          required: ['amount', 'description'],
          properties: {
            amount: { type: 'number' },
            description: { type: 'string' },
          },
        },
      };

      const mockAction: ActionTrigger = {
        id: 'action-001',
        tenant_id: 'tenant-123',
        action_type: 'send_invoice',
        action_name: 'Generate Invoice',
        config: JSON.stringify(actionData.config),
        parameter_schema: JSON.stringify(actionData.parameter_schema),
        active: 1,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };

      // First query: check existing -> null
      mockDb._setNextResults([]);
      // Second query: INSERT (run) -> no results needed
      mockDb._setNextResults([]);
      // Third query: SELECT created -> returns the action
      mockDb._setNextResults([mockAction]);

      const result = await service.registerAction('tenant-123', actionData);

      expect(result).toEqual(mockAction);
      expect(mockDb._queries.length).toBe(3);
      expect(mockDb._queries[0].sql).toContain('SELECT id FROM action_triggers');
      expect(mockDb._queries[1].sql).toContain('INSERT INTO action_triggers');
      expect(mockDb._queries[2].sql).toContain('SELECT * FROM action_triggers');
    });

    it('should update an existing action when one exists', async () => {
      const actionData = {
        action_type: 'send_invoice',
        action_name: 'Updated Invoice',
        config: { webhook_url: 'https://example.com/new-hook' },
        parameter_schema: {
          required: ['amount'],
          properties: { amount: { type: 'number' } },
        },
      };

      const updatedAction: ActionTrigger = {
        id: 'existing-001',
        tenant_id: 'tenant-123',
        action_type: 'send_invoice',
        action_name: 'Updated Invoice',
        config: JSON.stringify(actionData.config),
        parameter_schema: JSON.stringify(actionData.parameter_schema),
        active: 1,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      };

      // First query: check existing -> found
      mockDb._setNextResults([{ id: 'existing-001' }]);
      // Second query: UPDATE (run)
      mockDb._setNextResults([]);
      // Third query: SELECT updated
      mockDb._setNextResults([updatedAction]);

      const result = await service.registerAction('tenant-123', actionData);

      expect(result).toEqual(updatedAction);
      expect(mockDb._queries[1].sql).toContain('UPDATE action_triggers');
    });
  });

  // ==========================================================================
  // listActions
  // ==========================================================================

  describe('listActions', () => {
    it('should return all actions for a tenant', async () => {
      const mockActions: ActionTrigger[] = [
        {
          id: 'action-001',
          tenant_id: 'tenant-123',
          action_type: 'create_appointment',
          action_name: 'Book Appointment',
          config: '{}',
          parameter_schema: '{"required":["date","time_start","duration","contact_id"]}',
          active: 1,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'action-002',
          tenant_id: 'tenant-123',
          action_type: 'send_invoice',
          action_name: 'Generate Invoice',
          config: '{}',
          parameter_schema: '{"required":["amount","description"]}',
          active: 1,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      ];

      mockDb._setNextResults(mockActions);

      const result = await service.listActions('tenant-123');

      expect(result).toEqual(mockActions);
      expect(mockDb._queries[0].sql).toContain('SELECT * FROM action_triggers WHERE tenant_id = ?');
      expect(mockDb._queries[0].params[0]).toBe('tenant-123');
    });

    it('should return empty array when no actions are registered', async () => {
      mockDb._setNextResults([]);

      const result = await service.listActions('tenant-123');

      expect(result).toEqual([]);
    });
  });

  // ==========================================================================
  // executeAction
  // ==========================================================================

  describe('executeAction', () => {
    it('should return error when action type is not registered', async () => {
      // Query for action: not found
      mockDb._setNextResults([]);

      const result = await service.executeAction('tenant-123', 'unknown_action', {});

      expect(result.success).toBe(false);
      expect(result.action_type).toBe('unknown_action');
      expect(result.error).toContain('not registered or inactive');
    });

    it('should return error when parameter validation fails', async () => {
      const registeredAction: ActionTrigger = {
        id: 'action-001',
        tenant_id: 'tenant-123',
        action_type: 'create_ticket',
        action_name: 'Create Ticket',
        config: '{}',
        parameter_schema: JSON.stringify({
          required: ['type', 'description', 'priority'],
          properties: {
            type: { type: 'string' },
            description: { type: 'string' },
            priority: { type: 'string' },
          },
        }),
        active: 1,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };

      // Query for action: found
      mockDb._setNextResults([registeredAction]);

      // Try to execute with missing 'description'
      const result = await service.executeAction('tenant-123', 'create_ticket', {
        type: 'billing',
        // missing description and priority
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Parameter validation failed');
      expect(result.error).toContain('description');
    });

    it('should return error when parameter schema is malformed', async () => {
      const registeredAction: ActionTrigger = {
        id: 'action-001',
        tenant_id: 'tenant-123',
        action_type: 'create_ticket',
        action_name: 'Create Ticket',
        config: '{}',
        parameter_schema: 'not-valid-json{{{',
        active: 1,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };

      mockDb._setNextResults([registeredAction]);

      const result = await service.executeAction('tenant-123', 'create_ticket', {
        type: 'billing',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid parameter schema');
    });

    it('should execute create_appointment action successfully', async () => {
      const registeredAction: ActionTrigger = {
        id: 'action-001',
        tenant_id: 'tenant-123',
        action_type: 'create_appointment',
        action_name: 'Book Appointment',
        config: '{}',
        parameter_schema: JSON.stringify({
          required: ['date', 'time_start', 'duration', 'contact_id'],
          properties: {
            date: { type: 'string' },
            time_start: { type: 'string' },
            duration: { type: 'number' },
            contact_id: { type: 'string' },
          },
        }),
        active: 1,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };

      // Query for action: found
      mockDb._setNextResults([registeredAction]);
      // INSERT appointment (run)
      mockDb._setNextResults([]);

      const result = await service.executeAction('tenant-123', 'create_appointment', {
        date: '2024-03-15',
        time_start: '09:00',
        duration: 60,
        contact_id: 'contact-001',
      });

      expect(result.success).toBe(true);
      expect(result.action_type).toBe('create_appointment');
      expect(result.result_data.date).toBe('2024-03-15');
      expect(result.result_data.time_start).toBe('09:00');
      expect(result.result_data.time_end).toBe('10:00');
      expect(result.result_data.duration_minutes).toBe(60);
      expect(result.result_data.status).toBe('confirmed');
    });

    it('should execute create_ticket action successfully', async () => {
      const registeredAction: ActionTrigger = {
        id: 'action-002',
        tenant_id: 'tenant-123',
        action_type: 'create_ticket',
        action_name: 'Create Support Ticket',
        config: '{}',
        parameter_schema: JSON.stringify({
          required: ['type', 'description', 'priority'],
          properties: {
            type: { type: 'string' },
            description: { type: 'string' },
            priority: { type: 'string' },
          },
        }),
        active: 1,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };

      // Query for action: found
      mockDb._setNextResults([registeredAction]);
      // INSERT ticket (run)
      mockDb._setNextResults([]);

      const result = await service.executeAction('tenant-123', 'create_ticket', {
        type: 'billing',
        description: 'Cannot access payment page',
        priority: 'high',
      });

      expect(result.success).toBe(true);
      expect(result.action_type).toBe('create_ticket');
      expect(result.result_data.type).toBe('billing');
      expect(result.result_data.priority).toBe('high');
      expect(result.result_data.status).toBe('open');
    });

    it('should execute update_pipeline action for new pipeline entry', async () => {
      const registeredAction: ActionTrigger = {
        id: 'action-003',
        tenant_id: 'tenant-123',
        action_type: 'update_pipeline',
        action_name: 'Update Sales Pipeline',
        config: '{}',
        parameter_schema: JSON.stringify({
          required: ['contact_id', 'stage'],
          properties: {
            contact_id: { type: 'string' },
            stage: { type: 'string' },
          },
        }),
        active: 1,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };

      // Query for action: found
      mockDb._setNextResults([registeredAction]);
      // Check existing pipeline: none
      mockDb._setNextResults([]);
      // INSERT pipeline (run)
      mockDb._setNextResults([]);

      const result = await service.executeAction('tenant-123', 'update_pipeline', {
        contact_id: 'contact-001',
        stage: 'negotiation',
      });

      expect(result.success).toBe(true);
      expect(result.action_type).toBe('update_pipeline');
      expect(result.result_data.contact_id).toBe('contact-001');
      expect(result.result_data.previous_stage).toBeNull();
      expect(result.result_data.new_stage).toBe('negotiation');
    });

    it('should execute update_pipeline action for existing pipeline entry', async () => {
      const registeredAction: ActionTrigger = {
        id: 'action-003',
        tenant_id: 'tenant-123',
        action_type: 'update_pipeline',
        action_name: 'Update Sales Pipeline',
        config: '{}',
        parameter_schema: JSON.stringify({
          required: ['contact_id', 'stage'],
          properties: {
            contact_id: { type: 'string' },
            stage: { type: 'string' },
          },
        }),
        active: 1,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };

      // Query for action: found
      mockDb._setNextResults([registeredAction]);
      // Check existing pipeline: found
      mockDb._setNextResults([{ id: 'pipeline-001', stage: 'inquiry' }]);
      // UPDATE pipeline (run)
      mockDb._setNextResults([]);

      const result = await service.executeAction('tenant-123', 'update_pipeline', {
        contact_id: 'contact-001',
        stage: 'closing',
      });

      expect(result.success).toBe(true);
      expect(result.result_data.pipeline_id).toBe('pipeline-001');
      expect(result.result_data.previous_stage).toBe('inquiry');
      expect(result.result_data.new_stage).toBe('closing');
    });

    it('should handle time_end calculation correctly for appointments', async () => {
      const registeredAction: ActionTrigger = {
        id: 'action-001',
        tenant_id: 'tenant-123',
        action_type: 'create_appointment',
        action_name: 'Book Appointment',
        config: '{}',
        parameter_schema: JSON.stringify({
          required: ['date', 'time_start', 'duration', 'contact_id'],
          properties: {
            date: { type: 'string' },
            time_start: { type: 'string' },
            duration: { type: 'number' },
            contact_id: { type: 'string' },
          },
        }),
        active: 1,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };

      // Query for action: found
      mockDb._setNextResults([registeredAction]);
      // INSERT appointment (run)
      mockDb._setNextResults([]);

      const result = await service.executeAction('tenant-123', 'create_appointment', {
        date: '2024-03-15',
        time_start: '14:30',
        duration: 90,
        contact_id: 'contact-001',
      });

      expect(result.success).toBe(true);
      expect(result.result_data.time_end).toBe('16:00');
    });
  });
});
