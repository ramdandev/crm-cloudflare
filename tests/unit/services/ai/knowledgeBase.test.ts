/**
 * Unit tests for KnowledgeBaseService.
 * Validates Requirements: 2.1, 2.2, 2.4, 2.5, 2.6
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  KnowledgeBaseService,
  cosineSimilarity,
  decodeBase64ToFloat32,
  encodeFloat32ToBase64,
} from '../../../../src/services/ai/knowledgeBase';
import { createMockD1, createMockR2 } from '../../../helpers';

type MockD1 = ReturnType<typeof createMockD1> & {
  _setNextResults: (results: Record<string, unknown>[]) => void;
  _mockResults: Record<string, unknown>[][];
  _queries: Array<{ sql: string; params: unknown[] }>;
};

describe('KnowledgeBaseService', () => {
  let mockDb: MockD1;
  let mockR2: R2Bucket;
  let service: KnowledgeBaseService;

  beforeEach(() => {
    mockDb = createMockD1() as unknown as MockD1;
    mockR2 = createMockR2();
    service = new KnowledgeBaseService(mockDb as unknown as D1Database, mockR2);
    vi.restoreAllMocks();
  });

  describe('createEntry', () => {
    it('should create a knowledge base entry without embedding when no provider configured', async () => {
      const result = await service.createEntry('tenant-1', {
        title: 'FAQ: Return Policy',
        content: 'We accept returns within 30 days.',
        category: 'policies',
        tags: ['returns', 'policy'],
        entry_type: 'faq',
      });

      expect(result.id).toBeDefined();
      expect(result.tenant_id).toBe('tenant-1');
      expect(result.title).toBe('FAQ: Return Policy');
      expect(result.content).toBe('We accept returns within 30 days.');
      expect(result.category).toBe('policies');
      expect(result.tags).toBe(JSON.stringify(['returns', 'policy']));
      expect(result.embedding).toBeNull();
      expect(result.entry_type).toBe('faq');
      expect(result.source).toBe('manual');

      // Verify INSERT was called
      const insertQuery = mockDb._queries[0];
      expect(insertQuery?.sql).toContain('INSERT INTO knowledge_base');
    });

    it('should default entry_type to faq and source to manual', async () => {
      const result = await service.createEntry('tenant-1', {
        title: 'Test',
        content: 'Content',
        category: 'general',
      });

      expect(result.entry_type).toBe('faq');
      expect(result.source).toBe('manual');
    });

    it('should set created_at and updated_at timestamps', async () => {
      const result = await service.createEntry('tenant-1', {
        title: 'Test',
        content: 'Content',
        category: 'general',
      });

      expect(result.created_at).toBeDefined();
      expect(result.updated_at).toBeDefined();
      expect(result.created_at).toBe(result.updated_at);
    });
  });

  describe('getById', () => {
    it('should return null if entry not found', async () => {
      mockDb._setNextResults([]);
      const result = await service.getById('tenant-1', 'nonexistent-id');
      expect(result).toBeNull();
    });

    it('should return entry when found with correct tenant', async () => {
      const mockEntry = {
        id: 'kb-1',
        tenant_id: 'tenant-1',
        title: 'Test Entry',
        content: 'Test content',
        category: 'general',
        tags: null,
        embedding: null,
        file_r2_key: null,
        entry_type: 'faq',
        source: 'manual',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };
      mockDb._setNextResults([mockEntry]);
      const result = await service.getById('tenant-1', 'kb-1');
      expect(result).toEqual(mockEntry);

      // Verify query includes tenant_id
      const query = mockDb._queries[0];
      expect(query?.sql).toContain('WHERE id = ? AND tenant_id = ?');
      expect(query?.params).toContain('kb-1');
      expect(query?.params).toContain('tenant-1');
    });
  });

  describe('updateEntry', () => {
    it('should throw if entry not found', async () => {
      mockDb._setNextResults([]);
      await expect(
        service.updateEntry('tenant-1', 'nonexistent', { title: 'New Title' })
      ).rejects.toThrow('Knowledge base entry not found');
    });

    it('should update specified fields and updated_at', async () => {
      const existingEntry = {
        id: 'kb-1',
        tenant_id: 'tenant-1',
        title: 'Old Title',
        content: 'Old Content',
        category: 'general',
        tags: null,
        embedding: null,
        file_r2_key: null,
        entry_type: 'faq',
        source: 'manual',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };
      mockDb._setNextResults([existingEntry]);

      const result = await service.updateEntry('tenant-1', 'kb-1', {
        title: 'New Title',
        category: 'updated',
      });

      expect(result.title).toBe('New Title');
      expect(result.category).toBe('updated');
      expect(result.content).toBe('Old Content');
      expect(result.updated_at).not.toBe('2024-01-01T00:00:00.000Z');
    });
  });

  describe('deleteEntry', () => {
    it('should return false if entry not found', async () => {
      mockDb._setNextResults([]);
      const result = await service.deleteEntry('tenant-1', 'nonexistent');
      expect(result).toBe(false);
    });

    it('should delete entry and return true', async () => {
      const existingEntry = {
        id: 'kb-1',
        tenant_id: 'tenant-1',
        title: 'To Delete',
        content: 'Content',
        category: 'general',
        tags: null,
        embedding: null,
        file_r2_key: null,
        entry_type: 'faq',
        source: 'manual',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };
      mockDb._setNextResults([existingEntry]);
      const result = await service.deleteEntry('tenant-1', 'kb-1');
      expect(result).toBe(true);

      // Verify DELETE query
      const deleteQuery = mockDb._queries.find((q) => q.sql.includes('DELETE FROM knowledge_base'));
      expect(deleteQuery).toBeDefined();
      expect(deleteQuery?.sql).toContain('WHERE id = ? AND tenant_id = ?');
    });

    it('should delete R2 file if file_r2_key exists', async () => {
      // Put a file in mock R2
      await mockR2.put('tenant-1/kb/test-file.pdf', new ArrayBuffer(10));

      const existingEntry = {
        id: 'kb-1',
        tenant_id: 'tenant-1',
        title: 'With File',
        content: 'Content',
        category: 'general',
        tags: null,
        embedding: null,
        file_r2_key: 'tenant-1/kb/test-file.pdf',
        entry_type: 'faq',
        source: 'manual',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };
      mockDb._setNextResults([existingEntry]);
      const result = await service.deleteEntry('tenant-1', 'kb-1');
      expect(result).toBe(true);

      // Verify R2 object was deleted
      const r2Object = await mockR2.get('tenant-1/kb/test-file.pdf');
      expect(r2Object).toBeNull();
    });
  });

  describe('list', () => {
    it('should return paginated results with default page size', async () => {
      // First call: count query
      mockDb._setNextResults([{ total: 2 }]);
      // Second call: data query
      mockDb._setNextResults([
        { id: 'kb-1', tenant_id: 'tenant-1', title: 'Entry 1', content: 'Content 1', category: 'faq', tags: null, embedding: null, file_r2_key: null, entry_type: 'faq', source: 'manual', created_at: '2024-01-01', updated_at: '2024-01-01' },
        { id: 'kb-2', tenant_id: 'tenant-1', title: 'Entry 2', content: 'Content 2', category: 'faq', tags: null, embedding: null, file_r2_key: null, entry_type: 'faq', source: 'manual', created_at: '2024-01-02', updated_at: '2024-01-02' },
      ]);

      const result = await service.list('tenant-1');

      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.hasMore).toBe(false);
    });

    it('should filter by category', async () => {
      mockDb._setNextResults([{ total: 1 }]);
      mockDb._setNextResults([
        { id: 'kb-1', tenant_id: 'tenant-1', title: 'Product', content: 'Description', category: 'products', tags: null, embedding: null, file_r2_key: null, entry_type: 'product', source: 'manual', created_at: '2024-01-01', updated_at: '2024-01-01' },
      ]);

      const result = await service.list('tenant-1', { category: 'products' });

      expect(result.data).toHaveLength(1);
      // Verify category filter in query
      const countQuery = mockDb._queries[0];
      expect(countQuery?.sql).toContain('category = ?');
      expect(countQuery?.params).toContain('products');
    });

    it('should filter by entry_type', async () => {
      mockDb._setNextResults([{ total: 0 }]);
      mockDb._setNextResults([]);

      await service.list('tenant-1', { entry_type: 'policy' });

      const countQuery = mockDb._queries[0];
      expect(countQuery?.sql).toContain('entry_type = ?');
      expect(countQuery?.params).toContain('policy');
    });

    it('should enforce max page size of 50', async () => {
      mockDb._setNextResults([{ total: 0 }]);
      mockDb._setNextResults([]);

      const result = await service.list('tenant-1', { pageSize: 100 });

      expect(result.pageSize).toBe(50);
    });
  });

  describe('semanticSearch (text fallback)', () => {
    it('should fall back to text search when no provider configured', async () => {
      // First query: fetch all entries (none have embeddings, but some entries exist)
      mockDb._setNextResults([
        { id: 'kb-1', tenant_id: 'tenant-1', title: 'Return Policy', content: 'Returns accepted within 30 days', category: 'policies', tags: null, embedding: null, file_r2_key: null, entry_type: 'faq', source: 'manual', created_at: '2024-01-01', updated_at: '2024-01-01' },
      ]);
      // Second query: text search fallback (LIKE query)
      mockDb._setNextResults([
        { id: 'kb-1', tenant_id: 'tenant-1', title: 'Return Policy', content: 'Returns accepted within 30 days', category: 'policies', tags: null, embedding: null, file_r2_key: null, entry_type: 'faq', source: 'manual', created_at: '2024-01-01', updated_at: '2024-01-01' },
      ]);

      const results = await service.semanticSearch('tenant-1', 'return policy');

      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe('Return Policy');
    });

    it('should return empty array when no entries exist', async () => {
      mockDb._setNextResults([]); // all entries query returns empty

      const results = await service.semanticSearch('tenant-1', 'nonexistent query');

      expect(results).toHaveLength(0);
    });
  });

  describe('bulkImport', () => {
    it('should import valid entries', async () => {
      const entries = [
        { title: 'Entry 1', content: 'Content 1', category: 'general' },
        { title: 'Entry 2', content: 'Content 2', category: 'faq' },
      ];

      const result = await service.bulkImport('tenant-1', entries);

      expect(result.imported).toBe(2);
      expect(result.errors).toHaveLength(0);
    });

    it('should report validation errors for invalid entries', async () => {
      const entries = [
        { title: '', content: 'Content', category: 'general' },
        { title: 'Valid', content: '', category: 'general' },
        { title: 'Valid', content: 'Content', category: '' },
        { title: 'Valid', content: 'Content', category: 'general' },
      ];

      const result = await service.bulkImport('tenant-1', entries as any);

      expect(result.imported).toBe(1);
      expect(result.errors).toHaveLength(3);
      expect(result.errors[0]?.error).toContain('title');
      expect(result.errors[1]?.error).toContain('content');
      expect(result.errors[2]?.error).toContain('category');
    });

    it('should validate entry_type values', async () => {
      const entries = [
        { title: 'Test', content: 'Content', category: 'general', entry_type: 'invalid' as any },
      ];

      const result = await service.bulkImport('tenant-1', entries);

      expect(result.imported).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.error).toContain('entry_type');
    });

    it('should set source to bulk_import by default', async () => {
      const entries = [
        { title: 'Entry 1', content: 'Content 1', category: 'general' },
      ];

      const result = await service.bulkImport('tenant-1', entries);
      expect(result.imported).toBe(1);

      // Check the INSERT query params include 'bulk_import'
      const insertQuery = mockDb._queries.find((q) => q.sql.includes('INSERT INTO knowledge_base'));
      expect(insertQuery?.params).toContain('bulk_import');
    });
  });
});

describe('Utility Functions', () => {
  describe('cosineSimilarity', () => {
    it('should return 1.0 for identical vectors', () => {
      const vec = new Float32Array([1, 2, 3, 4]);
      const similarity = cosineSimilarity(vec, vec);
      expect(similarity).toBeCloseTo(1.0, 5);
    });

    it('should return 0 for orthogonal vectors', () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([0, 1, 0]);
      const similarity = cosineSimilarity(a, b);
      expect(similarity).toBeCloseTo(0, 5);
    });

    it('should return -1 for opposite vectors', () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([-1, 0, 0]);
      const similarity = cosineSimilarity(a, b);
      expect(similarity).toBeCloseTo(-1, 5);
    });

    it('should return 0 for different length vectors', () => {
      const a = new Float32Array([1, 2, 3]);
      const b = new Float32Array([1, 2]);
      const similarity = cosineSimilarity(a, b);
      expect(similarity).toBe(0);
    });

    it('should return 0 for zero vectors', () => {
      const a = new Float32Array([0, 0, 0]);
      const b = new Float32Array([1, 2, 3]);
      const similarity = cosineSimilarity(a, b);
      expect(similarity).toBe(0);
    });

    it('should be commutative', () => {
      const a = new Float32Array([1, 2, 3]);
      const b = new Float32Array([4, 5, 6]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 5);
    });
  });

  describe('encodeFloat32ToBase64 / decodeBase64ToFloat32', () => {
    it('should round-trip encode and decode correctly', () => {
      const original = new Float32Array([0.1, 0.5, -0.3, 1.0, -1.0]);
      const encoded = encodeFloat32ToBase64(original);
      const decoded = decodeBase64ToFloat32(encoded);

      expect(decoded.length).toBe(original.length);
      for (let i = 0; i < original.length; i++) {
        expect(decoded[i]).toBeCloseTo(original[i]!, 5);
      }
    });

    it('should handle empty vectors', () => {
      const original = new Float32Array([]);
      const encoded = encodeFloat32ToBase64(original);
      const decoded = decodeBase64ToFloat32(encoded);
      expect(decoded.length).toBe(0);
    });

    it('should produce a base64 string', () => {
      const original = new Float32Array([1.0, 2.0, 3.0]);
      const encoded = encodeFloat32ToBase64(original);
      // Base64 characters only
      expect(encoded).toMatch(/^[A-Za-z0-9+/=]*$/);
    });
  });
});
