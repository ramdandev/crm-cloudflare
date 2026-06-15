/**
 * Unit tests for the Audit Service (message status transition logging).
 * Validates Requirements: 8.1, 8.2
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  logStatusTransition,
  updateMessageStatusWithAudit,
  updateBroadcastMessageStatusWithAudit,
} from '../../../src/services/audit';
import { createMockD1 } from '../../helpers';

type MockD1 = ReturnType<typeof createMockD1> & {
  _setNextResults: (results: Record<string, unknown>[]) => void;
  _mockResults: Record<string, unknown>[][];
  _queries: Array<{ sql: string; params: unknown[] }>;
};

describe('Audit Service - Message Status Transition Logging', () => {
  let mockDb: MockD1;

  beforeEach(() => {
    mockDb = createMockD1() as unknown as MockD1;
    vi.restoreAllMocks();
  });

  describe('logStatusTransition', () => {
    it('should insert a status transition record into message_status_log', async () => {
      const messageId = 'msg-001';
      const tenantId = 'tenant-123';
      const previousStatus = 'sent';
      const newStatus = 'delivered';

      const logId = await logStatusTransition(
        mockDb as unknown as D1Database,
        messageId,
        tenantId,
        previousStatus,
        newStatus
      );

      // Should return a non-empty ID
      expect(logId).toBeDefined();
      expect(logId.length).toBeGreaterThan(0);

      // Should have executed an INSERT into message_status_log
      const insertQuery = mockDb._queries[0]!;
      expect(insertQuery.sql).toContain('INSERT INTO message_status_log');
      expect(insertQuery.sql).toContain('id, message_id, tenant_id, previous_status, new_status, changed_at');

      // Verify bound parameters
      expect(insertQuery.params[0]).toBe(logId); // id
      expect(insertQuery.params[1]).toBe(messageId); // message_id
      expect(insertQuery.params[2]).toBe(tenantId); // tenant_id
      expect(insertQuery.params[3]).toBe(previousStatus); // previous_status
      expect(insertQuery.params[4]).toBe(newStatus); // new_status
      expect(insertQuery.params[5]).toBeDefined(); // changed_at (ISO timestamp)
    });

    it('should handle null previousStatus for initial message creation', async () => {
      const messageId = 'msg-002';
      const tenantId = 'tenant-456';

      await logStatusTransition(
        mockDb as unknown as D1Database,
        messageId,
        tenantId,
        null,
        'sent'
      );

      const insertQuery = mockDb._queries[0]!;
      expect(insertQuery.params[3]).toBeNull(); // previous_status is null
      expect(insertQuery.params[4]).toBe('sent'); // new_status
    });

    it('should use a valid ISO 8601 timestamp for changed_at', async () => {
      await logStatusTransition(
        mockDb as unknown as D1Database,
        'msg-003',
        'tenant-789',
        'queued',
        'sent'
      );

      const insertQuery = mockDb._queries[0]!;
      const changedAt = insertQuery.params[5] as string;

      // Should be a valid ISO date string
      const parsedDate = new Date(changedAt);
      expect(parsedDate.toISOString()).toBe(changedAt);
    });

    it('should generate a unique UUID for each log entry', async () => {
      const logId1 = await logStatusTransition(
        mockDb as unknown as D1Database,
        'msg-004',
        'tenant-aaa',
        'sent',
        'delivered'
      );

      const logId2 = await logStatusTransition(
        mockDb as unknown as D1Database,
        'msg-005',
        'tenant-aaa',
        'delivered',
        'read'
      );

      expect(logId1).not.toBe(logId2);
    });
  });

  describe('updateMessageStatusWithAudit', () => {
    it('should update message status AND log the transition', async () => {
      const messageId = 'msg-010';
      const tenantId = 'tenant-100';

      await updateMessageStatusWithAudit(
        mockDb as unknown as D1Database,
        messageId,
        tenantId,
        'sent',
        'delivered'
      );

      // Should have executed two queries: UPDATE messages + INSERT message_status_log
      expect(mockDb._queries.length).toBe(2);

      // First query: UPDATE messages
      const updateQuery = mockDb._queries[0]!;
      expect(updateQuery.sql).toContain('UPDATE messages SET delivery_status = ?');
      expect(updateQuery.sql).toContain('WHERE id = ? AND tenant_id = ?');
      expect(updateQuery.params[0]).toBe('delivered'); // new status
      expect(updateQuery.params[2]).toBe(messageId); // message id
      expect(updateQuery.params[3]).toBe(tenantId); // tenant scoping

      // Second query: INSERT into message_status_log
      const insertQuery = mockDb._queries[1]!;
      expect(insertQuery.sql).toContain('INSERT INTO message_status_log');
      expect(insertQuery.params[1]).toBe(messageId); // message_id
      expect(insertQuery.params[2]).toBe(tenantId); // tenant_id
      expect(insertQuery.params[3]).toBe('sent'); // previous_status
      expect(insertQuery.params[4]).toBe('delivered'); // new_status
    });

    it('should scope the UPDATE query with tenant_id (Req 9.1)', async () => {
      await updateMessageStatusWithAudit(
        mockDb as unknown as D1Database,
        'msg-011',
        'tenant-200',
        'delivered',
        'read'
      );

      const updateQuery = mockDb._queries[0]!;
      expect(updateQuery.sql).toContain('tenant_id');
      expect(updateQuery.params).toContain('tenant-200');
    });
  });

  describe('updateBroadcastMessageStatusWithAudit', () => {
    it('should update broadcast_message status and log the transition', async () => {
      const broadcastMessageId = 'bm-001';
      const tenantId = 'tenant-300';

      await updateBroadcastMessageStatusWithAudit(
        mockDb as unknown as D1Database,
        broadcastMessageId,
        tenantId,
        'queued',
        'delivered'
      );

      // Should have executed two queries: UPDATE broadcast_messages + INSERT message_status_log
      expect(mockDb._queries.length).toBe(2);

      // First query: UPDATE broadcast_messages
      const updateQuery = mockDb._queries[0]!;
      expect(updateQuery.sql).toContain('UPDATE broadcast_messages SET delivery_status = ?');
      expect(updateQuery.params[0]).toBe('delivered');
      expect(updateQuery.params[2]).toBe(broadcastMessageId);
      expect(updateQuery.params[3]).toBe(tenantId);

      // Second query: INSERT into message_status_log
      const insertQuery = mockDb._queries[1]!;
      expect(insertQuery.sql).toContain('INSERT INTO message_status_log');
      expect(insertQuery.params[3]).toBe('queued'); // previous_status
      expect(insertQuery.params[4]).toBe('delivered'); // new_status
    });

    it('should include error_detail for failed broadcast messages', async () => {
      await updateBroadcastMessageStatusWithAudit(
        mockDb as unknown as D1Database,
        'bm-002',
        'tenant-400',
        'queued',
        'failed',
        'HTTP 400: Invalid recipient number'
      );

      const updateQuery = mockDb._queries[0]!;
      expect(updateQuery.sql).toContain('error_detail');
      expect(updateQuery.params[0]).toBe('failed'); // new status
      expect(updateQuery.params[1]).toBe('HTTP 400: Invalid recipient number'); // error_detail
    });

    it('should not include error_detail field when not provided', async () => {
      await updateBroadcastMessageStatusWithAudit(
        mockDb as unknown as D1Database,
        'bm-003',
        'tenant-500',
        'queued',
        'delivered'
      );

      const updateQuery = mockDb._queries[0]!;
      // When no error_detail, the query should not include error_detail
      expect(updateQuery.sql).not.toContain('error_detail');
    });
  });
});
