/**
 * Unit tests for the Billing Service.
 * Validates Requirements: 5.1, 5.2, 5.7, 5.8
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BillingService, computeIPaymuSignature } from '../../../src/services/billing';
import { createMockD1 } from '../../helpers';
import type { PaymentRequest } from '../../../src/types';

type MockD1 = ReturnType<typeof createMockD1> & {
  _setNextResults: (results: Record<string, unknown>[]) => void;
  _mockResults: Record<string, unknown>[][];
};

describe('BillingService', () => {
  let mockDb: MockD1;
  let service: BillingService;

  const TEST_API_KEY = 'test-api-key';
  const TEST_VA = 'test-va-1234';
  const TEST_SECRET = 'test-secret-key';

  beforeEach(() => {
    mockDb = createMockD1() as unknown as MockD1;
    service = new BillingService(mockDb as unknown as D1Database, TEST_API_KEY, TEST_VA, TEST_SECRET);
    vi.restoreAllMocks();
  });

  describe('computeIPaymuSignature', () => {
    it('should compute a hex-encoded HMAC-SHA256 signature', async () => {
      const body = JSON.stringify({ product: ['Test'], qty: [1], price: [100000] });
      const secret = 'my-secret';

      const signature = await computeIPaymuSignature(body, secret);

      // Should be a hex string (64 chars for SHA-256)
      expect(signature).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce different signatures for different bodies', async () => {
      const secret = 'my-secret';
      const sig1 = await computeIPaymuSignature('body1', secret);
      const sig2 = await computeIPaymuSignature('body2', secret);

      expect(sig1).not.toBe(sig2);
    });

    it('should produce different signatures for different secrets', async () => {
      const body = 'same-body';
      const sig1 = await computeIPaymuSignature(body, 'secret1');
      const sig2 = await computeIPaymuSignature(body, 'secret2');

      expect(sig1).not.toBe(sig2);
    });

    it('should produce consistent signature for same input', async () => {
      const body = 'consistent-body';
      const secret = 'consistent-secret';
      const sig1 = await computeIPaymuSignature(body, secret);
      const sig2 = await computeIPaymuSignature(body, secret);

      expect(sig1).toBe(sig2);
    });
  });

  describe('createPaymentLink', () => {
    const validRequest: PaymentRequest = {
      tenant_id: 'tenant-123',
      type: 'subscription_upgrade',
      plan_id: 'professional',
      amount: 500000,
      description: 'Upgrade to Professional Plan',
    };

    it('should create a transaction record in D1 with status=pending', async () => {
      // Mock successful iPaymu response
      const mockResponse = new Response(
        JSON.stringify({
          Status: 200,
          Data: { Url: 'https://my.ipaymu.com/pay/abc123', TransactionId: 'ipaymu-trx-001' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

      await service.createPaymentLink('tenant-123', validRequest);

      // The first query should be the INSERT with status='pending'
      const insertQuery = mockDb._queries.find((q) => q.sql.includes('INSERT INTO transactions'));
      expect(insertQuery).toBeDefined();
      expect(insertQuery!.params).toContain('tenant-123');
      expect(insertQuery!.params).toContain('pending');
      expect(insertQuery!.params).toContain('subscription_upgrade');
      expect(insertQuery!.params).toContain(500000);
      expect(insertQuery!.params).toContain('professional');
    });

    it('should call iPaymu API and return payment link result', async () => {
      const mockResponse = new Response(
        JSON.stringify({
          Status: 200,
          Data: { Url: 'https://my.ipaymu.com/pay/xyz789', TransactionId: 'ipaymu-trx-002' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

      const result = await service.createPaymentLink('tenant-123', validRequest);

      expect(result.payment_url).toBe('https://my.ipaymu.com/pay/xyz789');
      expect(result.transaction_id).toBeDefined();
      expect(result.expires_at).toBeDefined();

      // Verify expires_at is approximately 24 hours from now
      const expiresAt = new Date(result.expires_at).getTime();
      const expectedExpiry = Date.now() + 24 * 60 * 60 * 1000;
      expect(Math.abs(expiresAt - expectedExpiry)).toBeLessThan(5000); // Within 5 seconds
    });

    it('should send correct headers to iPaymu API', async () => {
      const mockResponse = new Response(
        JSON.stringify({
          Status: 200,
          Data: { Url: 'https://my.ipaymu.com/pay/test', TransactionId: 'trx-test' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

      await service.createPaymentLink('tenant-123', validRequest);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://my.ipaymu.com/api/v2/payment/direct');
      expect(options!.method).toBe('POST');
      expect(options!.headers).toHaveProperty('va', TEST_VA);
      expect(options!.headers).toHaveProperty('signature');
      expect(options!.headers).toHaveProperty('timestamp');
      expect(options!.headers).toHaveProperty('Content-Type', 'application/json');
    });

    it('should include referenceId in the request body', async () => {
      const mockResponse = new Response(
        JSON.stringify({
          Status: 200,
          Data: { Url: 'https://my.ipaymu.com/pay/ref', TransactionId: 'trx-ref' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

      await service.createPaymentLink('tenant-123', validRequest);

      const requestBody = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
      expect(requestBody).toHaveProperty('referenceId');
      expect(requestBody.product).toEqual([validRequest.description]);
      expect(requestBody.qty).toEqual([1]);
      expect(requestBody.price).toEqual([validRequest.amount]);
    });

    it('should update transaction with ipaymu_trx_id and payment_url after success', async () => {
      const mockResponse = new Response(
        JSON.stringify({
          Status: 200,
          Data: { Url: 'https://my.ipaymu.com/pay/updated', TransactionId: 'ipaymu-999' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

      await service.createPaymentLink('tenant-123', validRequest);

      // Find the UPDATE query that sets ipaymu_trx_id and payment_url
      const updateQuery = mockDb._queries.find(
        (q) => q.sql.includes('UPDATE transactions') && q.sql.includes('ipaymu_trx_id')
      );
      expect(updateQuery).toBeDefined();
      expect(updateQuery!.params).toContain('ipaymu-999');
      expect(updateQuery!.params).toContain('https://my.ipaymu.com/pay/updated');
    });

    it('should throw error when iPaymu API is unreachable (network error)', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network timeout'));

      await expect(service.createPaymentLink('tenant-123', validRequest)).rejects.toThrow(
        'Payment service unavailable'
      );

      // Verify transaction is marked as failed
      const failedUpdate = mockDb._queries.find(
        (q) => q.sql.includes('UPDATE transactions') && q.params.includes('failed')
      );
      expect(failedUpdate).toBeDefined();
    });

    it('should throw error when iPaymu returns non-200 status', async () => {
      const errorResponse = new Response('Internal Server Error', { status: 500 });
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorResponse);

      await expect(service.createPaymentLink('tenant-123', validRequest)).rejects.toThrow(
        'Payment service error'
      );

      // Verify transaction is marked as failed
      const failedUpdate = mockDb._queries.find(
        (q) => q.sql.includes('UPDATE transactions') && q.params.includes('failed')
      );
      expect(failedUpdate).toBeDefined();
    });

    it('should throw error when iPaymu returns invalid JSON', async () => {
      const invalidResponse = new Response('not json', { status: 200 });
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(invalidResponse);

      await expect(service.createPaymentLink('tenant-123', validRequest)).rejects.toThrow(
        'Payment service returned invalid response'
      );
    });

    it('should throw error when iPaymu response is missing payment URL', async () => {
      const noUrlResponse = new Response(
        JSON.stringify({ Status: 200, Data: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(noUrlResponse);

      await expect(service.createPaymentLink('tenant-123', validRequest)).rejects.toThrow(
        'Payment service did not return a payment URL'
      );
    });

    it('should handle quota_purchase type', async () => {
      const quotaRequest: PaymentRequest = {
        tenant_id: 'tenant-456',
        type: 'quota_purchase',
        quota_amount: 1000,
        amount: 250000,
        description: 'Purchase 1000 broadcast messages',
      };

      const mockResponse = new Response(
        JSON.stringify({
          Status: 200,
          Data: { Url: 'https://my.ipaymu.com/pay/quota', TransactionId: 'trx-quota' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

      const result = await service.createPaymentLink('tenant-456', quotaRequest);

      expect(result.payment_url).toBe('https://my.ipaymu.com/pay/quota');

      // Verify transaction includes quota_amount
      const insertQuery = mockDb._queries.find((q) => q.sql.includes('INSERT INTO transactions'));
      expect(insertQuery!.params).toContain('quota_purchase');
      expect(insertQuery!.params).toContain(1000);
    });
  });

  describe('getTransactionHistory', () => {
    it('should return paginated transaction history for a tenant', async () => {
      const mockTransactions = [
        {
          id: 'trx-1',
          tenant_id: 'tenant-123',
          ipaymu_trx_id: 'ipaymu-001',
          type: 'subscription_upgrade',
          amount: 500000,
          status: 'success',
          plan_id: 'professional',
          quota_amount: null,
          payment_url: 'https://my.ipaymu.com/pay/1',
          expires_at: '2024-12-02T00:00:00.000Z',
          created_at: '2024-12-01T00:00:00.000Z',
          updated_at: '2024-12-01T01:00:00.000Z',
        },
      ];

      // First query: COUNT
      mockDb._setNextResults([{ total: 1 }]);
      // Second query: SELECT
      mockDb._setNextResults(mockTransactions);

      const result = await service.getTransactionHistory('tenant-123', 1);

      expect(result.data).toHaveLength(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(50);
      expect(result.total).toBe(1);
      expect(result.hasMore).toBe(false);

      // Verify queries include tenant_id
      const queries = mockDb._queries;
      expect(queries[0]!.sql).toContain('WHERE tenant_id = ?');
      expect(queries[0]!.params[0]).toBe('tenant-123');
      expect(queries[1]!.sql).toContain('WHERE tenant_id = ?');
      expect(queries[1]!.params[0]).toBe('tenant-123');
    });

    it('should handle empty transaction history', async () => {
      mockDb._setNextResults([{ total: 0 }]);
      mockDb._setNextResults([]);

      const result = await service.getTransactionHistory('tenant-123', 1);

      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('should compute hasMore correctly when more pages exist', async () => {
      const mockTransactions = Array.from({ length: 50 }, (_, i) => ({
        id: `trx-${i}`,
        tenant_id: 'tenant-123',
        ipaymu_trx_id: null,
        type: 'quota_purchase',
        amount: 100000,
        status: 'pending',
        plan_id: null,
        quota_amount: 100,
        payment_url: null,
        expires_at: null,
        created_at: '2024-12-01T00:00:00.000Z',
        updated_at: '2024-12-01T00:00:00.000Z',
      }));

      mockDb._setNextResults([{ total: 75 }]);
      mockDb._setNextResults(mockTransactions);

      const result = await service.getTransactionHistory('tenant-123', 1);

      expect(result.hasMore).toBe(true);
      expect(result.total).toBe(75);
    });

    it('should order results by created_at DESC', async () => {
      mockDb._setNextResults([{ total: 0 }]);
      mockDb._setNextResults([]);

      await service.getTransactionHistory('tenant-123', 1);

      const selectQuery = mockDb._queries.find((q) => q.sql.includes('ORDER BY'));
      expect(selectQuery!.sql).toContain('ORDER BY created_at DESC');
    });

    it('should default to page 1 when page is 0 or negative', async () => {
      mockDb._setNextResults([{ total: 0 }]);
      mockDb._setNextResults([]);

      const result = await service.getTransactionHistory('tenant-123', 0);

      expect(result.page).toBe(1);
    });
  });
});
