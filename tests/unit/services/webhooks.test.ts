/**
 * Unit tests for the Webhook Processing Service.
 * Validates Requirements: 5.3, 5.4, 5.5, 5.6, 5.9, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { processIPaymuWebhook } from '../../../src/services/webhooks';
import { computeIPaymuSignature } from '../../../src/services/billing';
import { createMockD1 } from '../../helpers';
import type { IPaymuWebhook } from '../../../src/types';

type MockD1 = ReturnType<typeof createMockD1> & {
  _setNextResults: (results: Record<string, unknown>[]) => void;
  _mockResults: Record<string, unknown>[][];
};

const TEST_SECRET = 'test-webhook-secret';
const TEST_SOURCE_IP = '203.0.113.42';

/**
 * Helper: builds the signature payload string from an IPaymuWebhook body.
 * Must match the logic in webhooks.ts buildSignaturePayload().
 */
function buildSignaturePayload(body: Partial<IPaymuWebhook>): string {
  return JSON.stringify({
    trx_id: body.trx_id || '',
    status: body.status || '',
    status_code: body.status_code || '',
    sid: body.sid || '',
    amount: body.amount || 0,
    reference_id: body.reference_id || '',
  });
}

/**
 * Helper: creates a valid webhook body with correct signature.
 */
async function createValidWebhookBody(
  overrides: Partial<IPaymuWebhook> = {}
): Promise<IPaymuWebhook> {
  const baseBody: Omit<IPaymuWebhook, 'signature'> = {
    trx_id: 'ipaymu-trx-001',
    status: 'berhasil',
    status_code: '1',
    sid: 'session-123',
    amount: 500000,
    reference_id: 'txn-ref-001',
    ...overrides,
  };

  const payload = buildSignaturePayload(baseBody as IPaymuWebhook);
  const signature = await computeIPaymuSignature(payload, TEST_SECRET);

  return { ...baseBody, signature } as IPaymuWebhook;
}

describe('processIPaymuWebhook', () => {
  let mockDb: MockD1;

  beforeEach(() => {
    mockDb = createMockD1() as unknown as MockD1;
  });

  describe('Signature Validation (Req 10.1, 10.4)', () => {
    it('should reject with 401 when signature is invalid', async () => {
      const body: IPaymuWebhook = {
        trx_id: 'trx-001',
        status: 'berhasil',
        status_code: '1',
        sid: 'session-1',
        amount: 100000,
        reference_id: 'ref-001',
        signature: 'invalid-signature-value',
      };

      const result = await processIPaymuWebhook(
        mockDb as unknown as D1Database,
        TEST_SECRET,
        body,
        TEST_SOURCE_IP
      );

      expect(result.status).toBe(401);
      expect(result.body.success).toBe(false);
      expect(result.body.message).toContain('Invalid signature');
    });

    it('should reject with 401 when signature is missing', async () => {
      const body: IPaymuWebhook = {
        trx_id: 'trx-001',
        status: 'berhasil',
        status_code: '1',
        sid: 'session-1',
        amount: 100000,
        reference_id: 'ref-001',
        signature: '',
      };

      const result = await processIPaymuWebhook(
        mockDb as unknown as D1Database,
        TEST_SECRET,
        body,
        TEST_SOURCE_IP
      );

      expect(result.status).toBe(401);
      expect(result.body.success).toBe(false);
    });

    it('should log security alert with source IP on invalid signature', async () => {
      const body: IPaymuWebhook = {
        trx_id: 'trx-001',
        status: 'berhasil',
        status_code: '1',
        sid: 'session-1',
        amount: 100000,
        reference_id: 'ref-001',
        signature: 'bad-sig',
      };

      await processIPaymuWebhook(
        mockDb as unknown as D1Database,
        TEST_SECRET,
        body,
        TEST_SOURCE_IP
      );

      // Verify admin_alerts INSERT was called
      const alertInsert = mockDb._queries.find(
        (q) => q.sql.includes('INSERT INTO admin_alerts')
      );
      expect(alertInsert).toBeDefined();
      expect(alertInsert!.params).toContain('WEBHOOK_SIGNATURE_INVALID');
      expect(alertInsert!.params).toContain(TEST_SOURCE_IP);

      // Verify the detail contains source IP and timestamp
      const detailParam = alertInsert!.params.find(
        (p) => typeof p === 'string' && p.includes('source_ip')
      );
      expect(detailParam).toBeDefined();
      const detail = JSON.parse(detailParam as string);
      expect(detail.source_ip).toBe(TEST_SOURCE_IP);
      expect(detail.received_signature).toBe('bad-sig');
    });

    it('should NOT perform any state changes when signature is invalid', async () => {
      const body: IPaymuWebhook = {
        trx_id: 'trx-001',
        status: 'berhasil',
        status_code: '1',
        sid: 'session-1',
        amount: 100000,
        reference_id: 'ref-001',
        signature: 'invalid',
      };

      await processIPaymuWebhook(
        mockDb as unknown as D1Database,
        TEST_SECRET,
        body,
        TEST_SOURCE_IP
      );

      // Should only have the admin_alerts INSERT, no transaction updates
      const txnUpdates = mockDb._queries.filter(
        (q) => q.sql.includes('UPDATE transactions') || q.sql.includes('UPDATE tenants')
      );
      expect(txnUpdates).toHaveLength(0);

      // Should not have webhook_events INSERT
      const webhookInserts = mockDb._queries.filter(
        (q) => q.sql.includes('INSERT INTO webhook_events')
      );
      expect(webhookInserts).toHaveLength(0);
    });
  });

  describe('Event ID Validation (Req 10.5)', () => {
    it('should reject with 400 when trx_id is missing', async () => {
      // Create body with empty trx_id but valid signature
      const body = await createValidWebhookBody({ trx_id: '' });

      const result = await processIPaymuWebhook(
        mockDb as unknown as D1Database,
        TEST_SECRET,
        body,
        TEST_SOURCE_IP
      );

      expect(result.status).toBe(400);
      expect(result.body.success).toBe(false);
      expect(result.body.message).toContain('Missing or empty event ID');
    });

    it('should reject with 400 when trx_id is whitespace only', async () => {
      const body = await createValidWebhookBody({ trx_id: '   ' });

      const result = await processIPaymuWebhook(
        mockDb as unknown as D1Database,
        TEST_SECRET,
        body,
        TEST_SOURCE_IP
      );

      expect(result.status).toBe(400);
      expect(result.body.success).toBe(false);
    });

    it('should log malformed request with source IP when event_id missing', async () => {
      const body = await createValidWebhookBody({ trx_id: '' });

      await processIPaymuWebhook(
        mockDb as unknown as D1Database,
        TEST_SECRET,
        body,
        TEST_SOURCE_IP
      );

      const alertInsert = mockDb._queries.find(
        (q) => q.sql.includes('INSERT INTO admin_alerts')
      );
      expect(alertInsert).toBeDefined();
      expect(alertInsert!.params).toContain('WEBHOOK_MISSING_EVENT_ID');
      expect(alertInsert!.params).toContain(TEST_SOURCE_IP);
    });
  });

  describe('Idempotency (Req 10.2, 10.3)', () => {
    it('should return 200 without reprocessing when event already exists', async () => {
      const body = await createValidWebhookBody();

      // Mock: webhook_events table returns an existing record
      mockDb._setNextResults([{ id: 'existing-event-id' }]);

      const result = await processIPaymuWebhook(
        mockDb as unknown as D1Database,
        TEST_SECRET,
        body,
        TEST_SOURCE_IP
      );

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(result.body.message).toContain('already processed');

      // Should NOT have any UPDATE queries
      const updates = mockDb._queries.filter(
        (q) => q.sql.includes('UPDATE')
      );
      expect(updates).toHaveLength(0);

      // Should NOT insert into webhook_events again
      const webhookInserts = mockDb._queries.filter(
        (q) => q.sql.includes('INSERT INTO webhook_events')
      );
      expect(webhookInserts).toHaveLength(0);
    });

    it('should record event in webhook_events after successful processing', async () => {
      const body = await createValidWebhookBody();

      // Mock: no existing webhook event
      mockDb._setNextResults([]);
      // Mock: transaction found
      mockDb._setNextResults([
        {
          id: 'txn-ref-001',
          tenant_id: 'tenant-123',
          type: 'subscription_upgrade',
          plan_id: 'professional',
          quota_amount: null,
          status: 'pending',
        },
      ]);

      const result = await processIPaymuWebhook(
        mockDb as unknown as D1Database,
        TEST_SECRET,
        body,
        TEST_SOURCE_IP
      );

      expect(result.status).toBe(200);

      // Verify webhook_events INSERT
      const webhookInsert = mockDb._queries.find(
        (q) => q.sql.includes('INSERT INTO webhook_events')
      );
      expect(webhookInsert).toBeDefined();
      expect(webhookInsert!.params).toContain('ipaymu-trx-001'); // event_id
      expect(webhookInsert!.params).toContain('tenant-123'); // tenant_id
      expect(webhookInsert!.params).toContain('ipaymu'); // source
    });
  });

  describe('Successful Payment Processing (Req 5.4, 5.5)', () => {
    it('should activate subscription tier on successful subscription_upgrade', async () => {
      const body = await createValidWebhookBody({
        trx_id: 'ipaymu-sub-001',
        status_code: '1',
        reference_id: 'txn-sub-001',
      });

      // Mock: no existing webhook event
      mockDb._setNextResults([]);
      // Mock: transaction found
      mockDb._setNextResults([
        {
          id: 'txn-sub-001',
          tenant_id: 'tenant-456',
          type: 'subscription_upgrade',
          plan_id: 'professional',
          quota_amount: null,
          status: 'pending',
        },
      ]);

      const result = await processIPaymuWebhook(
        mockDb as unknown as D1Database,
        TEST_SECRET,
        body,
        TEST_SOURCE_IP
      );

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);

      // Verify transaction status updated to 'success'
      const txnUpdate = mockDb._queries.find(
        (q) => q.sql.includes('UPDATE transactions') && q.params.includes('success')
      );
      expect(txnUpdate).toBeDefined();
      expect(txnUpdate!.params).toContain('txn-sub-001');
      expect(txnUpdate!.params).toContain('tenant-456');

      // Verify tenant plan_tier updated
      const tenantUpdate = mockDb._queries.find(
        (q) => q.sql.includes('UPDATE tenants') && q.sql.includes('plan_tier')
      );
      expect(tenantUpdate).toBeDefined();
      expect(tenantUpdate!.params).toContain('professional');
      expect(tenantUpdate!.params).toContain('tenant-456');
    });

    it('should credit broadcast quota on successful quota_purchase', async () => {
      const body = await createValidWebhookBody({
        trx_id: 'ipaymu-quota-001',
        status_code: '1',
        reference_id: 'txn-quota-001',
      });

      // Mock: no existing webhook event
      mockDb._setNextResults([]);
      // Mock: transaction found
      mockDb._setNextResults([
        {
          id: 'txn-quota-001',
          tenant_id: 'tenant-789',
          type: 'quota_purchase',
          plan_id: null,
          quota_amount: 5000,
          status: 'pending',
        },
      ]);

      const result = await processIPaymuWebhook(
        mockDb as unknown as D1Database,
        TEST_SECRET,
        body,
        TEST_SOURCE_IP
      );

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);

      // Verify tenant broadcast_quota credited
      const quotaUpdate = mockDb._queries.find(
        (q) => q.sql.includes('UPDATE tenants') && q.sql.includes('broadcast_quota')
      );
      expect(quotaUpdate).toBeDefined();
      expect(quotaUpdate!.params).toContain(5000);
      expect(quotaUpdate!.params).toContain('tenant-789');
    });

    it('should handle "berhasil" status as success', async () => {
      const body = await createValidWebhookBody({
        trx_id: 'ipaymu-berhasil-001',
        status: 'berhasil',
        status_code: 'berhasil',
        reference_id: 'txn-berhasil-001',
      });

      // Mock: no existing webhook event
      mockDb._setNextResults([]);
      // Mock: transaction found
      mockDb._setNextResults([
        {
          id: 'txn-berhasil-001',
          tenant_id: 'tenant-001',
          type: 'subscription_upgrade',
          plan_id: 'enterprise',
          quota_amount: null,
          status: 'pending',
        },
      ]);

      const result = await processIPaymuWebhook(
        mockDb as unknown as D1Database,
        TEST_SECRET,
        body,
        TEST_SOURCE_IP
      );

      expect(result.status).toBe(200);

      // Should activate subscription
      const tenantUpdate = mockDb._queries.find(
        (q) => q.sql.includes('UPDATE tenants') && q.sql.includes('plan_tier')
      );
      expect(tenantUpdate).toBeDefined();
      expect(tenantUpdate!.params).toContain('enterprise');
    });
  });

  describe('Failed/Cancelled Payment Processing (Req 5.9)', () => {
    it('should update transaction status to failed without tier/quota changes', async () => {
      const body = await createValidWebhookBody({
        trx_id: 'ipaymu-fail-001',
        status: 'gagal',
        status_code: '0',
        reference_id: 'txn-fail-001',
      });

      // Mock: no existing webhook event
      mockDb._setNextResults([]);
      // Mock: transaction found
      mockDb._setNextResults([
        {
          id: 'txn-fail-001',
          tenant_id: 'tenant-fail',
          type: 'subscription_upgrade',
          plan_id: 'professional',
          quota_amount: null,
          status: 'pending',
        },
      ]);

      const result = await processIPaymuWebhook(
        mockDb as unknown as D1Database,
        TEST_SECRET,
        body,
        TEST_SOURCE_IP
      );

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);

      // Verify transaction updated to 'failed'
      const txnUpdate = mockDb._queries.find(
        (q) => q.sql.includes('UPDATE transactions') && q.params.includes('failed')
      );
      expect(txnUpdate).toBeDefined();

      // Verify NO tenant updates (no plan_tier or broadcast_quota changes)
      const tenantUpdates = mockDb._queries.filter(
        (q) => q.sql.includes('UPDATE tenants')
      );
      expect(tenantUpdates).toHaveLength(0);
    });

    it('should update transaction status to cancelled for cancelled payments', async () => {
      const body = await createValidWebhookBody({
        trx_id: 'ipaymu-cancel-001',
        status: 'cancelled',
        status_code: 'cancelled',
        reference_id: 'txn-cancel-001',
      });

      // Mock: no existing webhook event
      mockDb._setNextResults([]);
      // Mock: transaction found
      mockDb._setNextResults([
        {
          id: 'txn-cancel-001',
          tenant_id: 'tenant-cancel',
          type: 'quota_purchase',
          plan_id: null,
          quota_amount: 1000,
          status: 'pending',
        },
      ]);

      const result = await processIPaymuWebhook(
        mockDb as unknown as D1Database,
        TEST_SECRET,
        body,
        TEST_SOURCE_IP
      );

      expect(result.status).toBe(200);

      // Verify transaction updated to 'cancelled'
      const txnUpdate = mockDb._queries.find(
        (q) => q.sql.includes('UPDATE transactions') && q.params.includes('cancelled')
      );
      expect(txnUpdate).toBeDefined();

      // No quota changes
      const tenantUpdates = mockDb._queries.filter(
        (q) => q.sql.includes('UPDATE tenants')
      );
      expect(tenantUpdates).toHaveLength(0);
    });

    it('should not modify tier/quota on failed payment even for quota_purchase type', async () => {
      const body = await createValidWebhookBody({
        trx_id: 'ipaymu-fail-quota-001',
        status: 'failed',
        status_code: 'failed',
        reference_id: 'txn-fail-quota-001',
      });

      // Mock: no existing webhook event
      mockDb._setNextResults([]);
      // Mock: transaction found
      mockDb._setNextResults([
        {
          id: 'txn-fail-quota-001',
          tenant_id: 'tenant-noquota',
          type: 'quota_purchase',
          plan_id: null,
          quota_amount: 2000,
          status: 'pending',
        },
      ]);

      const result = await processIPaymuWebhook(
        mockDb as unknown as D1Database,
        TEST_SECRET,
        body,
        TEST_SOURCE_IP
      );

      expect(result.status).toBe(200);

      // No quota credit
      const quotaUpdates = mockDb._queries.filter(
        (q) => q.sql.includes('UPDATE tenants') && q.sql.includes('broadcast_quota')
      );
      expect(quotaUpdates).toHaveLength(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle webhook with no matching transaction gracefully', async () => {
      const body = await createValidWebhookBody({
        trx_id: 'ipaymu-orphan-001',
        reference_id: 'non-existent-txn',
      });

      // Mock: no existing webhook event
      mockDb._setNextResults([]);
      // Mock: no transaction found
      mockDb._setNextResults([]);

      const result = await processIPaymuWebhook(
        mockDb as unknown as D1Database,
        TEST_SECRET,
        body,
        TEST_SOURCE_IP
      );

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);

      // Should still record the webhook event
      const webhookInsert = mockDb._queries.find(
        (q) => q.sql.includes('INSERT INTO webhook_events')
      );
      expect(webhookInsert).toBeDefined();
    });

    it('should handle webhook with no reference_id', async () => {
      const body = await createValidWebhookBody({
        trx_id: 'ipaymu-noref-001',
        reference_id: '',
      });

      // Mock: no existing webhook event
      mockDb._setNextResults([]);

      const result = await processIPaymuWebhook(
        mockDb as unknown as D1Database,
        TEST_SECRET,
        body,
        TEST_SOURCE_IP
      );

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
    });
  });
});
