/**
 * Unit tests for the Contact CRUD Service.
 * Validates Requirements: 2.1, 2.2, 2.3, 2.4, 9.1
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ContactService } from '../../../src/services/contacts';
import { createMockD1 } from '../../helpers';

type MockD1 = ReturnType<typeof createMockD1> & {
  _setNextResults: (results: Record<string, unknown>[]) => void;
  _mockResults: Record<string, unknown>[][];
};

describe('ContactService', () => {
  let mockDb: MockD1;
  let service: ContactService;

  beforeEach(() => {
    mockDb = createMockD1() as unknown as MockD1;
    service = new ContactService(mockDb as unknown as D1Database);
  });

  describe('create', () => {
    it('should create a contact with valid input and return the created record', async () => {
      const result = await service.create('tenant-123', {
        full_name: 'John Doe',
        phone_number: '+6281234567890',
        email: 'john@example.com',
      });

      expect(result.tenant_id).toBe('tenant-123');
      expect(result.full_name).toBe('John Doe');
      expect(result.phone_number).toBe('+6281234567890');
      expect(result.email).toBe('john@example.com');
      expect(result.id).toBeDefined();
      expect(result.created_at).toBeDefined();
      expect(result.updated_at).toBeDefined();
      expect(result.metadata).toBeNull();

      // Verify the INSERT query was issued with tenant_id
      const insertQuery = mockDb._queries.find((q) => q.sql.includes('INSERT INTO contacts'));
      expect(insertQuery).toBeDefined();
      expect(insertQuery!.params).toContain('tenant-123');
    });

    it('should serialize metadata as JSON string', async () => {
      const metadata = { source: 'website', tags: ['vip'] };
      const result = await service.create('tenant-123', {
        full_name: 'Jane Doe',
        email: 'jane@example.com',
        metadata,
      });

      expect(result.metadata).toBe(JSON.stringify(metadata));
    });

    it('should set phone_number to null when not provided', async () => {
      const result = await service.create('tenant-123', {
        full_name: 'Jane Doe',
        email: 'jane@example.com',
      });

      expect(result.phone_number).toBeNull();
    });

    it('should throw validation error when full_name is missing', async () => {
      await expect(
        service.create('tenant-123', {
          full_name: '',
          email: 'test@example.com',
        })
      ).rejects.toThrow('Validation failed');
    });

    it('should throw validation error when both phone and email are missing', async () => {
      await expect(
        service.create('tenant-123', {
          full_name: 'John Doe',
        })
      ).rejects.toThrow('Validation failed');
    });

    it('should throw validation error for invalid E.164 phone number', async () => {
      await expect(
        service.create('tenant-123', {
          full_name: 'John Doe',
          phone_number: '12345', // Missing + prefix
        })
      ).rejects.toThrow('Validation failed');
    });
  });

  describe('list', () => {
    it('should list contacts with tenant_id filter and pagination', async () => {
      const mockContacts = [
        {
          id: 'contact-1',
          tenant_id: 'tenant-123',
          full_name: 'Alice',
          phone_number: '+1234567890',
          email: null,
          metadata: null,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      ];

      // First query: COUNT
      mockDb._setNextResults([{ total: 1 }]);
      // Second query: SELECT
      mockDb._setNextResults(mockContacts);

      const result = await service.list('tenant-123', 1, 50);

      expect(result.data).toHaveLength(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(50);
      expect(result.total).toBe(1);
      expect(result.hasMore).toBe(false);

      // Verify queries include tenant_id
      const queries = mockDb._queries;
      expect(queries.length).toBe(2);
      expect(queries[0]!.sql).toContain('WHERE tenant_id = ?');
      expect(queries[0]!.params[0]).toBe('tenant-123');
      expect(queries[1]!.sql).toContain('WHERE tenant_id = ?');
      expect(queries[1]!.params[0]).toBe('tenant-123');
    });

    it('should enforce maximum page size of 50', async () => {
      mockDb._setNextResults([{ total: 0 }]);
      mockDb._setNextResults([]);

      const result = await service.list('tenant-123', 1, 100);

      expect(result.pageSize).toBe(50);
      // Verify the LIMIT parameter is 50
      const selectQuery = mockDb._queries.find((q) => q.sql.includes('LIMIT'));
      expect(selectQuery!.params[1]).toBe(50);
    });

    it('should compute hasMore correctly when more pages exist', async () => {
      const mockContacts = Array.from({ length: 50 }, (_, i) => ({
        id: `contact-${i}`,
        tenant_id: 'tenant-123',
        full_name: `Contact ${i}`,
        phone_number: null,
        email: `c${i}@example.com`,
        metadata: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      }));

      mockDb._setNextResults([{ total: 75 }]);
      mockDb._setNextResults(mockContacts);

      const result = await service.list('tenant-123', 1, 50);

      expect(result.hasMore).toBe(true);
      expect(result.total).toBe(75);
    });

    it('should default to page 1 with page size 50', async () => {
      mockDb._setNextResults([{ total: 0 }]);
      mockDb._setNextResults([]);

      const result = await service.list('tenant-123');

      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(50);
    });

    it('should handle page values less than 1', async () => {
      mockDb._setNextResults([{ total: 0 }]);
      mockDb._setNextResults([]);

      const result = await service.list('tenant-123', 0, 10);

      expect(result.page).toBe(1);
    });
  });

  describe('getById', () => {
    it('should return a contact that belongs to the tenant', async () => {
      const mockContact = {
        id: 'contact-1',
        tenant_id: 'tenant-123',
        full_name: 'John Doe',
        phone_number: '+1234567890',
        email: 'john@example.com',
        metadata: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };

      mockDb._setNextResults([mockContact]);

      const result = await service.getById('tenant-123', 'contact-1');

      expect(result).toEqual(mockContact);

      // Verify query includes both id AND tenant_id
      const query = mockDb._queries[0]!;
      expect(query.sql).toContain('WHERE id = ? AND tenant_id = ?');
      expect(query.params[0]).toBe('contact-1');
      expect(query.params[1]).toBe('tenant-123');
    });

    it('should return null if contact does not exist', async () => {
      mockDb._setNextResults([]);

      const result = await service.getById('tenant-123', 'nonexistent');

      expect(result).toBeNull();
    });

    it('should return null if contact belongs to different tenant', async () => {
      // Mock returns nothing because the tenant_id filter excludes it
      mockDb._setNextResults([]);

      const result = await service.getById('tenant-123', 'contact-other-tenant');

      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('should update a contact and set updated_at timestamp', async () => {
      const existingContact = {
        id: 'contact-1',
        tenant_id: 'tenant-123',
        full_name: 'Old Name',
        phone_number: '+1234567890',
        email: 'old@example.com',
        metadata: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };

      // First call is getById
      mockDb._setNextResults([existingContact]);

      const result = await service.update('tenant-123', 'contact-1', {
        full_name: 'New Name',
      });

      expect(result.full_name).toBe('New Name');
      expect(result.phone_number).toBe('+1234567890'); // Preserved
      expect(result.email).toBe('old@example.com'); // Preserved
      expect(result.updated_at).not.toBe('2024-01-01T00:00:00.000Z');

      // Verify UPDATE query includes tenant_id
      const updateQuery = mockDb._queries.find((q) => q.sql.includes('UPDATE contacts'));
      expect(updateQuery).toBeDefined();
      expect(updateQuery!.sql).toContain('WHERE id = ? AND tenant_id = ?');
    });

    it('should throw error when contact not found', async () => {
      mockDb._setNextResults([]);

      await expect(
        service.update('tenant-123', 'nonexistent', { full_name: 'Test' })
      ).rejects.toThrow('Contact not found');
    });

    it('should throw validation error for invalid phone number on update', async () => {
      await expect(
        service.update('tenant-123', 'contact-1', {
          phone_number: 'invalid-phone',
        })
      ).rejects.toThrow('Validation failed');
    });

    it('should update metadata as JSON string', async () => {
      const existingContact = {
        id: 'contact-1',
        tenant_id: 'tenant-123',
        full_name: 'John',
        phone_number: '+1234567890',
        email: null,
        metadata: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };

      mockDb._setNextResults([existingContact]);

      const newMetadata = { custom: 'value' };
      const result = await service.update('tenant-123', 'contact-1', {
        metadata: newMetadata,
      });

      expect(result.metadata).toBe(JSON.stringify(newMetadata));
    });
  });

  describe('delete', () => {
    it('should delete a contact with tenant_id check', async () => {
      // Mock that the delete affected 1 row
      const mockDbWithChanges = createMockD1() as unknown as MockD1;
      // Override the mock to return changes = 1
      const origPrepare = (mockDbWithChanges as any).prepare.bind(mockDbWithChanges);
      (mockDbWithChanges as any).prepare = (sql: string) => {
        const stmt = origPrepare(sql);
        const origRun = stmt.run.bind(stmt);
        stmt.run = async () => {
          const result = await origRun();
          result.meta.changes = 1;
          return result;
        };
        return stmt;
      };

      const svc = new ContactService(mockDbWithChanges as unknown as D1Database);
      await svc.delete('tenant-123', 'contact-1');

      // Verify DELETE query includes tenant_id
      const deleteQuery = mockDbWithChanges._queries.find((q) => q.sql.includes('DELETE'));
      expect(deleteQuery).toBeDefined();
      expect(deleteQuery!.sql).toContain('WHERE id = ? AND tenant_id = ?');
      expect(deleteQuery!.params[0]).toBe('contact-1');
      expect(deleteQuery!.params[1]).toBe('tenant-123');
    });

    it('should throw error when contact not found or belongs to different tenant', async () => {
      // Default mock returns changes = 0
      await expect(service.delete('tenant-123', 'nonexistent')).rejects.toThrow('Contact not found');
    });
  });

  describe('tenant isolation (Requirement 9.1)', () => {
    it('every query should include tenant_id as mandatory filter', async () => {
      // Test create
      await service.create('tenant-A', {
        full_name: 'Test',
        email: 'test@example.com',
      });
      expect(mockDb._queries[0]!.params).toContain('tenant-A');

      // Reset queries
      mockDb._queries.length = 0;

      // Test list
      mockDb._setNextResults([{ total: 0 }]);
      mockDb._setNextResults([]);
      await service.list('tenant-B');
      expect(mockDb._queries[0]!.params[0]).toBe('tenant-B');
      expect(mockDb._queries[1]!.params[0]).toBe('tenant-B');

      // Reset queries
      mockDb._queries.length = 0;

      // Test getById
      mockDb._setNextResults([]);
      await service.getById('tenant-C', 'some-id');
      expect(mockDb._queries[0]!.params).toContain('tenant-C');
    });
  });
});
