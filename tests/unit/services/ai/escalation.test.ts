/**
 * Unit tests for EscalationService.
 * Validates Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockKV, createMockD1 } from '../../../helpers';
import { EscalationService } from '../../../../src/services/ai/escalation';
import type { EscalationStaff, PendingEscalation } from '../../../../src/types/ai';

describe('EscalationService', () => {
  let mockKv: KVNamespace;
  let mockDb: ReturnType<typeof createMockD1>;
  let service: EscalationService;

  beforeEach(() => {
    mockKv = createMockKV();
    mockDb = createMockD1();
    service = new EscalationService(mockDb as unknown as D1Database, mockKv);
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // parseStaffCommand
  // ==========================================================================

  describe('parseStaffCommand', () => {
    it('should parse valid #KB command with three parts', () => {
      const result = service.parseStaffCommand('#KB: Cara Retur | Pelanggan bisa retur dalam 7 hari | kebijakan');
      expect(result).toEqual({
        title: 'Cara Retur',
        content: 'Pelanggan bisa retur dalam 7 hari',
        category: 'kebijakan',
      });
    });

    it('should handle extra whitespace around parts', () => {
      const result = service.parseStaffCommand('#KB:   Title Here   |   Content here   |   category-name   ');
      expect(result).toEqual({
        title: 'Title Here',
        content: 'Content here',
        category: 'category-name',
      });
    });

    it('should return null for messages not starting with #KB:', () => {
      expect(service.parseStaffCommand('Hello, this is a normal message')).toBeNull();
      expect(service.parseStaffCommand('KB: missing hash')).toBeNull();
      expect(service.parseStaffCommand('#kb: lowercase')).toBeNull();
    });

    it('should return null for #KB messages with wrong number of parts', () => {
      expect(service.parseStaffCommand('#KB: only two parts | content')).toBeNull();
      expect(service.parseStaffCommand('#KB: one | two | three | four')).toBeNull();
      expect(service.parseStaffCommand('#KB: just one part')).toBeNull();
    });

    it('should return null for #KB messages with empty parts', () => {
      expect(service.parseStaffCommand('#KB: | content | category')).toBeNull();
      expect(service.parseStaffCommand('#KB: title | | category')).toBeNull();
      expect(service.parseStaffCommand('#KB: title | content |')).toBeNull();
    });

    it('should handle leading/trailing whitespace in message', () => {
      const result = service.parseStaffCommand('  #KB: Title | Content | Category  ');
      expect(result).toEqual({
        title: 'Title',
        content: 'Content',
        category: 'Category',
      });
    });
  });

  // ==========================================================================
  // escalateToStaff
  // ==========================================================================

  describe('escalateToStaff', () => {
    const mockStaff: EscalationStaff = {
      id: 'staff-001',
      tenant_id: 'tenant-123',
      name: 'Budi',
      phone_number: '6281234567890',
      priority_order: 1,
      specialties: JSON.stringify(['sales', 'product']),
      active: 1,
    };

    it('should throw error when no active staff configured', async () => {
      // No staff in results
      mockDb._setNextResults([]);

      await expect(
        service.escalateToStaff(
          'tenant-123',
          'contact-001',
          'Berapa harga produk X?',
          'Customer tanya tentang harga',
          'http://gowa.local',
          'gowa-key'
        )
      ).rejects.toThrow('No active escalation staff configured for this tenant');
    });

    it('should create escalation with correct data when staff exists', async () => {
      // Mock: staff lookup returns a staff member
      mockDb._setNextResults([mockStaff as unknown as Record<string, unknown>]);

      // Mock fetch for WhatsApp send
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      const result = await service.escalateToStaff(
        'tenant-123',
        'contact-001',
        'Berapa harga produk X?',
        'Customer tanya tentang harga',
        'http://gowa.local',
        'gowa-key'
      );

      // Verify result structure
      expect(result.tenant_id).toBe('tenant-123');
      expect(result.contact_id).toBe('contact-001');
      expect(result.staff_id).toBe('staff-001');
      expect(result.question).toBe('Berapa harga produk X?');
      expect(result.context_summary).toBe('Customer tanya tentang harga');
      expect(result.status).toBe('pending');
      expect(result.staff_response).toBeNull();
      expect(result.responded_at).toBeNull();
      expect(result.correlation_id).toMatch(/^esc-/);
      expect(result.timeout_at).toBeDefined();

      // Verify WhatsApp message was sent to staff
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://gowa.local/send/message',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Hai Budi'),
        })
      );

      // Verify KV was updated with escalation state
      const kvValue = await mockKv.get(`escalation_pending:${result.correlation_id}`);
      expect(kvValue).not.toBeNull();
      const kvState = JSON.parse(kvValue!);
      expect(kvState.tenant_id).toBe('tenant-123');
      expect(kvState.contact_id).toBe('contact-001');
      expect(kvState.staff_id).toBe('staff-001');

      fetchSpy.mockRestore();
    });

    it('should set timeout_at to approximately 30 minutes from now', async () => {
      mockDb._setNextResults([mockStaff as unknown as Record<string, unknown>]);
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      const before = Date.now();
      const result = await service.escalateToStaff(
        'tenant-123',
        'contact-001',
        'Question?',
        'Context',
        'http://gowa.local',
        'gowa-key'
      );
      const after = Date.now();

      const timeoutMs = new Date(result.timeout_at).getTime();
      const expectedMin = before + 30 * 60 * 1000;
      const expectedMax = after + 30 * 60 * 1000;

      expect(timeoutMs).toBeGreaterThanOrEqual(expectedMin - 100);
      expect(timeoutMs).toBeLessThanOrEqual(expectedMax + 100);

      vi.restoreAllMocks();
    });

    it('should send correctly formatted escalation message', async () => {
      mockDb._setNextResults([mockStaff as unknown as Record<string, unknown>]);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      await service.escalateToStaff(
        'tenant-123',
        'contact-001',
        'Bisa refund gak?',
        'Customer mau refund barang',
        'http://gowa.local',
        'gowa-key'
      );

      const fetchCall = fetchSpy.mock.calls[0];
      const body = JSON.parse(fetchCall![1]!.body as string);
      expect(body.phone).toBe('6281234567890');
      expect(body.message).toContain('Hai Budi');
      expect(body.message).toContain('Bisa refund gak?');
      expect(body.message).toContain('Customer mau refund barang');
      expect(body.message).toContain('Reply pesan ini langsung ya');

      fetchSpy.mockRestore();
    });
  });

  // ==========================================================================
  // handleStaffResponse
  // ==========================================================================

  describe('handleStaffResponse', () => {
    it('should return null when no pending escalation found for correlation_id', async () => {
      mockDb._setNextResults([]);

      const result = await service.handleStaffResponse('esc-nonexistent', 'Some answer');
      expect(result).toBeNull();
    });

    it('should update escalation and return customer data on valid response', async () => {
      const mockEscalation: PendingEscalation = {
        id: 'esc-id-001',
        tenant_id: 'tenant-123',
        contact_id: 'contact-001',
        staff_id: 'staff-001',
        correlation_id: 'esc-correlation-001',
        question: 'Berapa harga produk X?',
        context_summary: 'Customer interested in product X',
        status: 'pending',
        staff_response: null,
        created_at: '2024-01-01T00:00:00.000Z',
        responded_at: null,
        timeout_at: '2024-01-01T00:30:00.000Z',
      };

      // First query: look up escalation
      mockDb._setNextResults([mockEscalation as unknown as Record<string, unknown>]);
      // Second query: UPDATE (run)
      mockDb._setNextResults([]);
      // Third query: INSERT KB entry (run)
      mockDb._setNextResults([]);

      // Store KV entry to verify it gets deleted
      await mockKv.put('escalation_pending:esc-correlation-001', JSON.stringify({ test: true }));

      const result = await service.handleStaffResponse(
        'esc-correlation-001',
        'Harga produk X Rp 500.000'
      );

      expect(result).toEqual({
        tenantId: 'tenant-123',
        contactId: 'contact-001',
        answer: 'Harga produk X Rp 500.000',
      });

      // Verify DB was updated (3 queries: SELECT, UPDATE, INSERT KB)
      expect(mockDb._queries.length).toBe(3);

      // Verify UPDATE query sets answered status
      const updateQuery = mockDb._queries[1];
      expect(updateQuery.sql).toContain("status = 'answered'");
      expect(updateQuery.params).toContain('Harga produk X Rp 500.000');

      // Verify KB INSERT was called
      const insertQuery = mockDb._queries[2];
      expect(insertQuery.sql).toContain('INSERT INTO knowledge_base');

      // Verify KV entry was deleted
      const kvValue = await mockKv.get('escalation_pending:esc-correlation-001');
      expect(kvValue).toBeNull();
    });
  });

  // ==========================================================================
  // addKnowledgeFromResponse
  // ==========================================================================

  describe('addKnowledgeFromResponse', () => {
    it('should insert a KB entry with learned type and escalation source', async () => {
      mockDb._setNextResults([]);

      await service.addKnowledgeFromResponse(
        'tenant-123',
        'How to return a product?',
        'Customer can return within 7 days',
        'kebijakan'
      );

      expect(mockDb._queries).toHaveLength(1);
      const query = mockDb._queries[0];
      expect(query.sql).toContain('INSERT INTO knowledge_base');
      expect(query.sql).toContain("'learned'");
      expect(query.sql).toContain("'escalation'");
      expect(query.params).toContain('tenant-123');
      expect(query.params).toContain('How to return a product?');
      expect(query.params).toContain('Customer can return within 7 days');
      expect(query.params).toContain('kebijakan');
    });
  });

  // ==========================================================================
  // checkTimeouts
  // ==========================================================================

  describe('checkTimeouts', () => {
    it('should return 0 when no timed-out escalations exist', async () => {
      mockDb._setNextResults([]);

      const count = await service.checkTimeouts('tenant-123');
      expect(count).toBe(0);
    });

    it('should process timed-out escalations and create tickets', async () => {
      const timedOutEscalations: PendingEscalation[] = [
        {
          id: 'esc-id-001',
          tenant_id: 'tenant-123',
          contact_id: 'contact-001',
          staff_id: 'staff-001',
          correlation_id: 'esc-corr-001',
          question: 'Question 1',
          context_summary: 'Context 1',
          status: 'pending',
          staff_response: null,
          created_at: '2024-01-01T00:00:00.000Z',
          responded_at: null,
          timeout_at: '2024-01-01T00:30:00.000Z',
        },
        {
          id: 'esc-id-002',
          tenant_id: 'tenant-123',
          contact_id: 'contact-002',
          staff_id: 'staff-001',
          correlation_id: 'esc-corr-002',
          question: 'Question 2',
          context_summary: 'Context 2',
          status: 'pending',
          staff_response: null,
          created_at: '2024-01-01T00:00:00.000Z',
          responded_at: null,
          timeout_at: '2024-01-01T00:30:00.000Z',
        },
      ];

      // Query to get timed-out escalations
      mockDb._setNextResults(timedOutEscalations as unknown as Record<string, unknown>[]);
      // For each escalation: UPDATE + INSERT ticket
      mockDb._setNextResults([]); // UPDATE esc-001
      mockDb._setNextResults([]); // INSERT ticket for esc-001
      mockDb._setNextResults([]); // UPDATE esc-002
      mockDb._setNextResults([]); // INSERT ticket for esc-002

      // Store KV entries to verify deletion
      await mockKv.put('escalation_pending:esc-corr-001', JSON.stringify({}));
      await mockKv.put('escalation_pending:esc-corr-002', JSON.stringify({}));

      const count = await service.checkTimeouts('tenant-123');

      expect(count).toBe(2);

      // Verify queries: 1 SELECT + 2 UPDATEs + 2 INSERTs = 5
      expect(mockDb._queries.length).toBe(5);

      // Verify UPDATE queries
      expect(mockDb._queries[1].sql).toContain("status = 'timeout'");
      expect(mockDb._queries[3].sql).toContain("status = 'timeout'");

      // Verify ticket INSERTs
      expect(mockDb._queries[2].sql).toContain('INSERT INTO support_tickets');
      expect(mockDb._queries[4].sql).toContain('INSERT INTO support_tickets');

      // Verify KV entries were deleted
      const kv1 = await mockKv.get('escalation_pending:esc-corr-001');
      const kv2 = await mockKv.get('escalation_pending:esc-corr-002');
      expect(kv1).toBeNull();
      expect(kv2).toBeNull();
    });
  });

  // ==========================================================================
  // configureStaff
  // ==========================================================================

  describe('configureStaff', () => {
    it('should deactivate existing staff and insert new ones', async () => {
      // UPDATE to deactivate existing
      mockDb._setNextResults([]);
      // INSERT for each new staff member
      mockDb._setNextResults([]);
      mockDb._setNextResults([]);

      const result = await service.configureStaff('tenant-123', [
        { name: 'Budi', phone_number: '6281234567890', priority_order: 1, specialties: ['sales'] },
        { name: 'Ani', phone_number: '6289876543210', priority_order: 2 },
      ]);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Budi');
      expect(result[0].phone_number).toBe('6281234567890');
      expect(result[0].priority_order).toBe(1);
      expect(result[0].specialties).toBe(JSON.stringify(['sales']));
      expect(result[0].active).toBe(1);

      expect(result[1].name).toBe('Ani');
      expect(result[1].phone_number).toBe('6289876543210');
      expect(result[1].priority_order).toBe(2);
      expect(result[1].specialties).toBeNull();
      expect(result[1].active).toBe(1);

      // Verify queries: 1 UPDATE deactivate + 2 INSERTs = 3
      expect(mockDb._queries.length).toBe(3);
      expect(mockDb._queries[0].sql).toContain('UPDATE escalation_staff SET active = 0');
    });
  });

  // ==========================================================================
  // getStaff
  // ==========================================================================

  describe('getStaff', () => {
    it('should return active staff ordered by priority', async () => {
      const staffList: EscalationStaff[] = [
        {
          id: 'staff-001',
          tenant_id: 'tenant-123',
          name: 'Budi',
          phone_number: '6281234567890',
          priority_order: 1,
          specialties: JSON.stringify(['sales']),
          active: 1,
        },
        {
          id: 'staff-002',
          tenant_id: 'tenant-123',
          name: 'Ani',
          phone_number: '6289876543210',
          priority_order: 2,
          specialties: null,
          active: 1,
        },
      ];

      mockDb._setNextResults(staffList as unknown as Record<string, unknown>[]);

      const result = await service.getStaff('tenant-123');

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Budi');
      expect(result[1].name).toBe('Ani');

      // Verify query
      expect(mockDb._queries[0].sql).toContain('ORDER BY priority_order ASC');
      expect(mockDb._queries[0].sql).toContain('active = 1');
    });

    it('should return empty array when no staff configured', async () => {
      mockDb._setNextResults([]);

      const result = await service.getStaff('tenant-123');
      expect(result).toEqual([]);
    });
  });
});
