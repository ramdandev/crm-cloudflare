/**
 * Unit tests for the Broadcast Service.
 * Validates Requirements: 4.1, 4.5, 4.6
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  BroadcastService,
  InsufficientQuotaError,
  InvalidContactListError,
} from '../../../src/services/broadcast';
import { createMockD1, createMockQueue } from '../../helpers';

type MockD1 = ReturnType<typeof createMockD1> & {
  _setNextResults: (results: Record<string, unknown>[]) => void;
  _mockResults: Record<string, unknown>[][];
};

describe('BroadcastService', () => {
  let mockDb: MockD1;
  let mockQueue: ReturnType<typeof createMockQueue>;
  let service: BroadcastService;

  beforeEach(() => {
    mockDb = createMockD1() as unknown as MockD1;
    mockQueue = createMockQueue();
    service = new BroadcastService(
      mockDb as unknown as D1Database,
      mockQueue as unknown as Queue
    );
  });

  describe('initiateBroadcast', () => {
    it('should reject with InvalidContactListError when contact list is empty', async () => {
      await expect(
        service.initiateBroadcast('tenant-123', {
          template_name: 'welcome',
          template_language: 'en',
          contact_ids: [],
        })
      ).rejects.toThrow(InvalidContactListError);
    });

    it('should reject with InvalidContactListError when contact list exceeds 10,000', async () => {
      const contacts = Array.from({ length: 10_001 }, (_, i) => `contact-${i}`);

      await expect(
        service.initiateBroadcast('tenant-123', {
          template_name: 'welcome',
          template_language: 'en',
          contact_ids: contacts,
        })
      ).rejects.toThrow(InvalidContactListError);
    });

    it('should accept exactly 1 contact (minimum)', async () => {
      // SELECT broadcast_quota
      mockDb._setNextResults([{ broadcast_quota: 100 }]);
      // UPDATE tenants (quota deduction) - need to simulate successful update
      mockDb._mockResults.push([]);
      // INSERT broadcasts
      mockDb._mockResults.push([]);
      // SELECT contacts
      mockDb._setNextResults([{ id: 'contact-1', phone_number: '+6281234567890' }]);
      // INSERT broadcast_messages
      mockDb._mockResults.push([]);

      // Override prepare to return changes=1 for the UPDATE
      const origPrepare = (mockDb as any).prepare.bind(mockDb);
      let updateCalled = false;
      (mockDb as any).prepare = (sql: string) => {
        const stmt = origPrepare(sql);
        if (sql.includes('UPDATE tenants SET broadcast_quota')) {
          const origRun = stmt.run.bind(stmt);
          stmt.run = async () => {
            updateCalled = true;
            const result = await origRun();
            result.meta.changes = 1;
            return result;
          };
        }
        return stmt;
      };

      const result = await service.initiateBroadcast('tenant-123', {
        template_name: 'welcome',
        template_language: 'en',
        contact_ids: ['contact-1'],
      });

      expect(result.broadcast_id).toBeDefined();
      expect(result.total_messages).toBe(1);
      expect(result.status).toBe('queued');
      expect(updateCalled).toBe(true);
    });

    it('should reject with InsufficientQuotaError when quota is insufficient', async () => {
      // SELECT broadcast_quota - tenant has 5 quota
      mockDb._setNextResults([{ broadcast_quota: 5 }]);

      await expect(
        service.initiateBroadcast('tenant-123', {
          template_name: 'promo',
          template_language: 'en',
          contact_ids: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10'],
        })
      ).rejects.toThrow(InsufficientQuotaError);

      // Verify no messages were queued
      expect(mockQueue._messages).toHaveLength(0);
    });

    it('should atomically deduct quota and enqueue messages on success', async () => {
      const contactIds = ['contact-1', 'contact-2', 'contact-3'];
      const contacts = [
        { id: 'contact-1', phone_number: '+6281111111111' },
        { id: 'contact-2', phone_number: '+6282222222222' },
        { id: 'contact-3', phone_number: '+6283333333333' },
      ];

      // Query sequence:
      // 1. SELECT broadcast_quota FROM tenants → .first()
      // 2. UPDATE tenants SET broadcast_quota → .run() (overridden)
      // 3. INSERT INTO broadcasts → .run()
      // 4. SELECT id, phone_number FROM contacts → .all()
      // 5-7. INSERT INTO broadcast_messages (×3) → .run()
      mockDb._setNextResults([{ broadcast_quota: 100 }]); // 1
      mockDb._mockResults.push([]); // 2 (UPDATE - consumed by overridden run)
      mockDb._mockResults.push([]); // 3 (INSERT broadcasts)
      mockDb._setNextResults(contacts); // 4 (SELECT contacts)
      mockDb._mockResults.push([]); // 5 (INSERT broadcast_messages)
      mockDb._mockResults.push([]); // 6
      mockDb._mockResults.push([]); // 7

      // Override prepare to return changes=1 for the UPDATE
      const origPrepare = (mockDb as any).prepare.bind(mockDb);
      (mockDb as any).prepare = (sql: string) => {
        const stmt = origPrepare(sql);
        if (sql.includes('UPDATE tenants SET broadcast_quota')) {
          const origRun = stmt.run.bind(stmt);
          stmt.run = async () => {
            const result = await origRun();
            result.meta.changes = 1;
            return result;
          };
        }
        return stmt;
      };

      const result = await service.initiateBroadcast('tenant-123', {
        template_name: 'promo',
        template_language: 'en',
        contact_ids: contactIds,
      });

      expect(result.broadcast_id).toBeDefined();
      expect(result.total_messages).toBe(3);
      expect(result.status).toBe('queued');

      // Verify messages were queued
      expect(mockQueue._messages).toHaveLength(3);

      // Verify queue message structure
      const queueMsg = mockQueue._messages[0] as any;
      expect(queueMsg.broadcast_id).toBe(result.broadcast_id);
      expect(queueMsg.tenant_id).toBe('tenant-123');
      expect(queueMsg.template_name).toBe('promo');
      expect(queueMsg.template_language).toBe('en');
      expect(queueMsg.retry_count).toBe(0);
      expect(queueMsg.max_retries).toBe(5);
    });

    it('should skip contacts without phone numbers', async () => {
      const contactIds = ['contact-1', 'contact-2'];
      const contacts = [
        { id: 'contact-1', phone_number: '+6281111111111' },
        { id: 'contact-2', phone_number: null }, // No phone number
      ];

      // Query sequence:
      // 1. SELECT broadcast_quota → .first()
      // 2. UPDATE tenants → .run() (overridden)
      // 3. INSERT broadcasts → .run()
      // 4. SELECT contacts → .all()
      // 5. INSERT broadcast_messages (only 1) → .run()
      mockDb._setNextResults([{ broadcast_quota: 100 }]); // 1
      mockDb._mockResults.push([]); // 2
      mockDb._mockResults.push([]); // 3
      mockDb._setNextResults(contacts); // 4
      mockDb._mockResults.push([]); // 5

      const origPrepare = (mockDb as any).prepare.bind(mockDb);
      (mockDb as any).prepare = (sql: string) => {
        const stmt = origPrepare(sql);
        if (sql.includes('UPDATE tenants SET broadcast_quota')) {
          const origRun = stmt.run.bind(stmt);
          stmt.run = async () => {
            const result = await origRun();
            result.meta.changes = 1;
            return result;
          };
        }
        return stmt;
      };

      const result = await service.initiateBroadcast('tenant-123', {
        template_name: 'promo',
        template_language: 'en',
        contact_ids: contactIds,
      });

      // Only 1 message queued since contact-2 has no phone number
      expect(result.total_messages).toBe(1);
      expect(mockQueue._messages).toHaveLength(1);
    });

    it('should include template_params in queue messages when provided', async () => {
      const contactIds = ['contact-1'];
      const contacts = [{ id: 'contact-1', phone_number: '+6281111111111' }];
      const templateParams = [{ name: 'John', code: '1234' }];

      // Query sequence:
      // 1. SELECT broadcast_quota → .first()
      // 2. UPDATE tenants → .run() (overridden)
      // 3. INSERT broadcasts → .run()
      // 4. SELECT contacts → .all()
      // 5. INSERT broadcast_messages → .run()
      mockDb._setNextResults([{ broadcast_quota: 100 }]); // 1
      mockDb._mockResults.push([]); // 2
      mockDb._mockResults.push([]); // 3
      mockDb._setNextResults(contacts); // 4
      mockDb._mockResults.push([]); // 5

      const origPrepare = (mockDb as any).prepare.bind(mockDb);
      (mockDb as any).prepare = (sql: string) => {
        const stmt = origPrepare(sql);
        if (sql.includes('UPDATE tenants SET broadcast_quota')) {
          const origRun = stmt.run.bind(stmt);
          stmt.run = async () => {
            const result = await origRun();
            result.meta.changes = 1;
            return result;
          };
        }
        return stmt;
      };

      await service.initiateBroadcast('tenant-123', {
        template_name: 'otp',
        template_language: 'id',
        contact_ids: contactIds,
        template_params: templateParams,
      });

      const queueMsg = mockQueue._messages[0] as any;
      expect(queueMsg.template_params).toEqual({ name: 'John', code: '1234' });
    });

    it('should handle concurrent quota deduction failure gracefully', async () => {
      // SELECT broadcast_quota - shows sufficient
      mockDb._setNextResults([{ broadcast_quota: 10 }]);

      // Override prepare so UPDATE returns changes=0 (concurrent deduction happened)
      const origPrepare = (mockDb as any).prepare.bind(mockDb);
      (mockDb as any).prepare = (sql: string) => {
        const stmt = origPrepare(sql);
        if (sql.includes('UPDATE tenants SET broadcast_quota')) {
          const origRun = stmt.run.bind(stmt);
          stmt.run = async () => {
            const result = await origRun();
            result.meta.changes = 0; // Simulate concurrent deduction
            return result;
          };
        }
        return stmt;
      };

      // Re-check after failed UPDATE returns lower quota
      mockDb._setNextResults([{ broadcast_quota: 3 }]);

      await expect(
        service.initiateBroadcast('tenant-123', {
          template_name: 'promo',
          template_language: 'en',
          contact_ids: ['c1', 'c2', 'c3', 'c4', 'c5'],
        })
      ).rejects.toThrow(InsufficientQuotaError);

      // Verify no messages were queued
      expect(mockQueue._messages).toHaveLength(0);
    });

    it('should throw error when tenant is not found', async () => {
      // SELECT broadcast_quota - no tenant
      mockDb._setNextResults([]);

      await expect(
        service.initiateBroadcast('nonexistent-tenant', {
          template_name: 'welcome',
          template_language: 'en',
          contact_ids: ['contact-1'],
        })
      ).rejects.toThrow('Tenant not found');
    });
  });

  describe('checkQuota', () => {
    it('should return the current broadcast_quota for a tenant', async () => {
      mockDb._setNextResults([{ broadcast_quota: 500 }]);

      const quota = await service.checkQuota('tenant-123');

      expect(quota).toBe(500);
    });

    it('should throw error when tenant is not found', async () => {
      mockDb._setNextResults([]);

      await expect(service.checkQuota('nonexistent')).rejects.toThrow('Tenant not found');
    });

    it('should return 0 when quota is exhausted', async () => {
      mockDb._setNextResults([{ broadcast_quota: 0 }]);

      const quota = await service.checkQuota('tenant-123');

      expect(quota).toBe(0);
    });
  });
});
