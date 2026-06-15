/**
 * Billing Service with iPaymu payment link generation.
 * Handles payment link creation and transaction history retrieval.
 *
 * Requirements: 5.1, 5.2, 5.7, 5.8
 */

import type {
  PaymentRequest,
  PaymentLinkResult,
  Transaction,
  TransactionStatus,
  PaginatedResult,
} from '../types';

/** Default page size for transaction history */
const DEFAULT_PAGE_SIZE = 50;

/** Maximum page size for transaction history */
const MAX_PAGE_SIZE = 50;

/** iPaymu API endpoint for direct payment */
const IPAYMU_API_URL = 'https://my.ipaymu.com/api/v2/payment/direct';

/** Payment link expiration time: 24 hours in milliseconds */
const PAYMENT_LINK_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Computes the iPaymu API signature.
 * Signature is HMAC-SHA256 of the request body using the secret key.
 *
 * @param body - The JSON-encoded request body string
 * @param secret - The iPaymu shared secret
 * @returns Hex-encoded HMAC-SHA256 signature
 */
export async function computeIPaymuSignature(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  // Convert ArrayBuffer to hex string
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * BillingService provides payment link generation and transaction management.
 * All operations are tenant-scoped for data isolation.
 */
export class BillingService {
  private db: D1Database;
  private apiKey: string;
  private va: string;
  private secret: string;

  constructor(db: D1Database, apiKey: string, va: string, secret: string) {
    this.db = db;
    this.apiKey = apiKey;
    this.va = va;
    this.secret = secret;
  }

  /**
   * Creates a payment link via the iPaymu API.
   *
   * Flow:
   * 1. Create a transaction record in D1 with status='pending'
   * 2. Call iPaymu API to generate a payment URL
   * 3. Update transaction with ipaymu_trx_id and payment_url
   * 4. Return PaymentLinkResult
   *
   * On iPaymu API failure, throws an error (route returns 503) and logs details.
   *
   * @param tenantId - The tenant requesting the payment link
   * @param request - The payment request details
   * @returns PaymentLinkResult with payment URL, transaction ID, and expiry
   * @throws Error if iPaymu API is unreachable or returns an error
   */
  async createPaymentLink(tenantId: string, request: PaymentRequest): Promise<PaymentLinkResult> {
    const transactionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + PAYMENT_LINK_EXPIRY_MS).toISOString();

    // Step 1: Create transaction record in D1 with status='pending'
    await this.db
      .prepare(
        `INSERT INTO transactions (id, tenant_id, ipaymu_trx_id, type, amount, status, plan_id, quota_amount, payment_url, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        transactionId,
        tenantId,
        null,
        request.type,
        request.amount,
        'pending' as TransactionStatus,
        request.plan_id || null,
        request.quota_amount || null,
        null,
        expiresAt,
        now,
        now
      )
      .run();

    // Step 2: Prepare iPaymu API request
    const timestamp = new Date().toISOString();

    const requestBody = JSON.stringify({
      product: [request.description],
      qty: [1],
      price: [request.amount],
      returnUrl: `https://crm.example.com/billing/return`,
      notifyUrl: `https://crm.example.com/webhooks/ipaymu`,
      referenceId: transactionId,
      buyerName: tenantId,
      buyerEmail: `tenant-${tenantId}@crm.example.com`,
      paymentMethod: 'va',
    });

    // Compute signature: HMAC-SHA256 of the body using the secret
    const signature = await computeIPaymuSignature(requestBody, this.secret);

    // Step 3: Call iPaymu API
    let response: Response;
    try {
      response = await fetch(IPAYMU_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'va': this.va,
          'signature': signature,
          'timestamp': timestamp,
        },
        body: requestBody,
      });
    } catch (error) {
      // Network error - iPaymu is unreachable
      const errorMessage = error instanceof Error ? error.message : 'Unknown network error';
      console.error(`[BillingService] iPaymu API unreachable: ${errorMessage}`, {
        tenantId,
        transactionId,
        amount: request.amount,
        type: request.type,
      });

      // Update transaction status to failed
      await this.db
        .prepare('UPDATE transactions SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
        .bind('failed', new Date().toISOString(), transactionId, tenantId)
        .run();

      throw new Error(`Payment service unavailable: ${errorMessage}`);
    }

    // Handle non-successful HTTP responses
    if (!response.ok) {
      let errorDetail = `HTTP ${response.status}`;
      try {
        const errorBody = await response.text();
        errorDetail = `HTTP ${response.status}: ${errorBody}`;
      } catch {
        // Unable to read response body
      }

      console.error(`[BillingService] iPaymu API error: ${errorDetail}`, {
        tenantId,
        transactionId,
        amount: request.amount,
        type: request.type,
        status: response.status,
      });

      // Update transaction status to failed
      await this.db
        .prepare('UPDATE transactions SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
        .bind('failed', new Date().toISOString(), transactionId, tenantId)
        .run();

      throw new Error(`Payment service error: ${errorDetail}`);
    }

    // Step 4: Parse iPaymu response and extract payment URL
    let ipaymuResponse: { Status: number; Data: { Url: string; TransactionId: string | number } };
    try {
      ipaymuResponse = await response.json();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Invalid JSON response';
      console.error(`[BillingService] iPaymu invalid response: ${errorMessage}`, {
        tenantId,
        transactionId,
      });

      await this.db
        .prepare('UPDATE transactions SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
        .bind('failed', new Date().toISOString(), transactionId, tenantId)
        .run();

      throw new Error(`Payment service returned invalid response: ${errorMessage}`);
    }

    const paymentUrl = ipaymuResponse.Data?.Url;
    const ipaymuTrxId = ipaymuResponse.Data?.TransactionId
      ? String(ipaymuResponse.Data.TransactionId)
      : null;

    if (!paymentUrl) {
      console.error(`[BillingService] iPaymu response missing payment URL`, {
        tenantId,
        transactionId,
        response: ipaymuResponse,
      });

      await this.db
        .prepare('UPDATE transactions SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
        .bind('failed', new Date().toISOString(), transactionId, tenantId)
        .run();

      throw new Error('Payment service did not return a payment URL');
    }

    // Step 5: Update transaction with payment URL and iPaymu transaction ID
    await this.db
      .prepare(
        'UPDATE transactions SET ipaymu_trx_id = ?, payment_url = ?, updated_at = ? WHERE id = ? AND tenant_id = ?'
      )
      .bind(ipaymuTrxId, paymentUrl, new Date().toISOString(), transactionId, tenantId)
      .run();

    // Step 6: Return result
    return {
      payment_url: paymentUrl,
      transaction_id: transactionId,
      expires_at: expiresAt,
    };
  }

  /**
   * Retrieves paginated transaction history for a tenant.
   *
   * @param tenantId - The tenant to get transaction history for
   * @param page - The page number (1-based)
   * @returns Paginated list of transactions
   */
  async getTransactionHistory(
    tenantId: string,
    page: number = 1
  ): Promise<PaginatedResult<Transaction>> {
    const effectivePage = Math.max(1, page);
    const pageSize = DEFAULT_PAGE_SIZE;
    const offset = (effectivePage - 1) * pageSize;

    // Get total count
    const countResult = await this.db
      .prepare('SELECT COUNT(*) as total FROM transactions WHERE tenant_id = ?')
      .bind(tenantId)
      .first<{ total: number }>();

    const total = countResult?.total ?? 0;

    // Fetch paginated transactions
    const results = await this.db
      .prepare(
        `SELECT id, tenant_id, ipaymu_trx_id, type, amount, status, plan_id, quota_amount, payment_url, expires_at, created_at, updated_at
         FROM transactions
         WHERE tenant_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
      .bind(tenantId, pageSize, offset)
      .all<Transaction>();

    const data = results.results ?? [];

    return {
      data,
      page: effectivePage,
      pageSize,
      total,
      hasMore: offset + data.length < total,
    };
  }
}

// ============================================================================
// Standalone function wrappers for route consumption
// ============================================================================

/**
 * Creates a payment link for a tenant.
 *
 * @param db - D1 database binding
 * @param apiKey - iPaymu API key
 * @param va - iPaymu virtual account
 * @param secret - iPaymu shared secret
 * @param tenantId - The tenant ID
 * @param request - Payment request details
 * @returns PaymentLinkResult
 * @throws Error if iPaymu is unreachable (should result in 503)
 */
export async function createPaymentLink(
  db: D1Database,
  apiKey: string,
  va: string,
  secret: string,
  tenantId: string,
  request: PaymentRequest
): Promise<PaymentLinkResult> {
  const service = new BillingService(db, apiKey, va, secret);
  return service.createPaymentLink(tenantId, request);
}

/**
 * Gets transaction history for a tenant.
 *
 * @param db - D1 database binding
 * @param apiKey - iPaymu API key
 * @param va - iPaymu virtual account
 * @param secret - iPaymu shared secret
 * @param tenantId - The tenant ID
 * @param page - Page number
 * @returns Paginated transaction list
 */
export async function getTransactionHistory(
  db: D1Database,
  apiKey: string,
  va: string,
  secret: string,
  tenantId: string,
  page: number = 1
): Promise<PaginatedResult<Transaction>> {
  const service = new BillingService(db, apiKey, va, secret);
  return service.getTransactionHistory(tenantId, page);
}
