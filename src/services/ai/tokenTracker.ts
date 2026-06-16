/**
 * Token Tracker Service for AI Sales Agent.
 * Tracks token usage per tenant, enforces monthly quotas,
 * and sends warning notifications when approaching limits.
 *
 * Requirements: 13.1, 13.2, 13.3
 */

import type { TokenUsageRecord } from '../../types/ai';

/** KV cache key pattern for monthly token usage */
const TOKEN_USAGE_CACHE_PREFIX = 'token_usage:';

/** TTL for token usage cache in seconds */
const TOKEN_USAGE_CACHE_TTL = 3600;


/** Token quota configuration from D1 */
interface TokenQuota {
  id: string;
  tenant_id: string;
  monthly_limit: number;
  warning_threshold: number;
  created_at: string;
  updated_at: string;
}

/** Quota check result */
export interface QuotaCheckResult {
  exceeded: boolean;
  current: number;
  limit: number | null;
}

/**
 * TokenTrackerService provides token usage tracking and quota enforcement.
 * Uses KV caching for monthly counters with D1 as source of truth.
 */
export class TokenTrackerService {
  /**
   * Record a token usage event.
   * Inserts a record into token_usage table and updates the KV monthly counter.
   *
   * @param db - D1 database binding
   * @param kv - KV namespace binding
   * @param tenantId - The tenant consuming tokens
   * @param model - The AI model used
   * @param promptTokens - Number of prompt tokens consumed
   * @param completionTokens - Number of completion tokens consumed
   * @param purpose - Purpose of the token usage
   * @returns The created TokenUsageRecord
   */
  async recordUsage(
    db: D1Database,
    kv: KVNamespace,
    tenantId: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
    purpose: 'conversation' | 'summary' | 'embedding' | 'guardrail'
  ): Promise<TokenUsageRecord> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const totalTokens = promptTokens + completionTokens;

    const record: TokenUsageRecord = {
      id,
      tenant_id: tenantId,
      model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      purpose,
      created_at: now,
    };

    // Insert into D1
    await db
      .prepare(
        `INSERT INTO token_usage (id, tenant_id, model, prompt_tokens, completion_tokens, total_tokens, purpose, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.tenant_id,
        record.model,
        record.prompt_tokens,
        record.completion_tokens,
        record.total_tokens,
        record.purpose,
        record.created_at
      )
      .run();

    // Update KV monthly counter
    const monthKey = getMonthlyKey(tenantId);
    try {
      const currentStr = await kv.get(monthKey);
      const currentTotal = currentStr ? parseInt(currentStr, 10) : 0;
      const newTotal = currentTotal + totalTokens;
      await kv.put(monthKey, String(newTotal), {
        expirationTtl: TOKEN_USAGE_CACHE_TTL,
      });
    } catch (error) {
      console.error('[TokenTrackerService] KV counter update failed:', error);
    }

    return record;
  }


  /**
   * Get current month's total token usage for a tenant.
   * Checks KV cache first, falls back to D1 aggregation on cache miss.
   *
   * @param db - D1 database binding
   * @param kv - KV namespace binding
   * @param tenantId - The tenant to check usage for
   * @returns Total tokens used this month
   */
  async getMonthlyUsage(
    db: D1Database,
    kv: KVNamespace,
    tenantId: string
  ): Promise<number> {
    const monthKey = getMonthlyKey(tenantId);

    // Check KV cache first
    try {
      const cached = await kv.get(monthKey);
      if (cached !== null) {
        return parseInt(cached, 10);
      }
    } catch (error) {
      console.error('[TokenTrackerService] KV cache read failed:', error);
    }

    // Fallback to D1 aggregation
    const monthStart = getMonthStartDate();
    const result = await db
      .prepare(
        `SELECT COALESCE(SUM(total_tokens), 0) as total
         FROM token_usage
         WHERE tenant_id = ? AND created_at >= ?`
      )
      .bind(tenantId, monthStart)
      .first<{ total: number }>();

    const total = result?.total ?? 0;

    // Populate KV cache
    try {
      await kv.put(monthKey, String(total), {
        expirationTtl: TOKEN_USAGE_CACHE_TTL,
      });
    } catch (error) {
      console.error('[TokenTrackerService] KV cache write failed:', error);
    }

    return total;
  }

  /**
   * Check if the tenant has exceeded their monthly token quota.
   *
   * @param db - D1 database binding
   * @param kv - KV namespace binding
   * @param tenantId - The tenant to check quota for
   * @returns QuotaCheckResult with exceeded status, current usage, and limit
   */
  async checkQuota(
    db: D1Database,
    kv: KVNamespace,
    tenantId: string
  ): Promise<QuotaCheckResult> {
    // Get tenant's quota config
    const quota = await db
      .prepare('SELECT * FROM token_quotas WHERE tenant_id = ?')
      .bind(tenantId)
      .first<TokenQuota>();

    if (!quota) {
      // No quota configured - no limit
      const current = await this.getMonthlyUsage(db, kv, tenantId);
      return { exceeded: false, current, limit: null };
    }

    const current = await this.getMonthlyUsage(db, kv, tenantId);

    return {
      exceeded: current >= quota.monthly_limit,
      current,
      limit: quota.monthly_limit,
    };
  }


  /**
   * Get aggregated usage history for a tenant within a date range.
   *
   * @param db - D1 database binding
   * @param tenantId - The tenant to get history for
   * @param startDate - Optional start date filter (YYYY-MM-DD)
   * @param endDate - Optional end date filter (YYYY-MM-DD)
   * @returns Array of usage records grouped by date
   */
  async getUsageHistory(
    db: D1Database,
    tenantId: string,
    startDate?: string,
    endDate?: string
  ): Promise<Array<{ date: string; total_tokens: number; prompt_tokens: number; completion_tokens: number; request_count: number }>> {
    let query = `SELECT
      DATE(created_at) as date,
      SUM(total_tokens) as total_tokens,
      SUM(prompt_tokens) as prompt_tokens,
      SUM(completion_tokens) as completion_tokens,
      COUNT(*) as request_count
    FROM token_usage
    WHERE tenant_id = ?`;

    const params: unknown[] = [tenantId];

    if (startDate) {
      query += ' AND created_at >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND created_at <= ?';
      params.push(endDate + 'T23:59:59');
    }

    query += ' GROUP BY DATE(created_at) ORDER BY date DESC';

    const results = await db
      .prepare(query)
      .bind(...params)
      .all<{ date: string; total_tokens: number; prompt_tokens: number; completion_tokens: number; request_count: number }>();

    return results.results ?? [];
  }

  /**
   * Send a quota warning notification when usage exceeds 80% of the monthly limit.
   * Sends a WhatsApp message to the tenant admin via Go-Wa.
   *
   * @param db - D1 database binding
   * @param kv - KV namespace binding
   * @param tenantId - The tenant to warn
   * @param gowaBaseUrl - Go-Wa gateway base URL
   * @param gowaApiKey - Go-Wa gateway API key
   */
  async sendQuotaWarning(
    db: D1Database,
    kv: KVNamespace,
    tenantId: string,
    gowaBaseUrl: string,
    gowaApiKey: string
  ): Promise<void> {
    // Check if warning was already sent this month
    const warningKey = `quota_warning:${tenantId}:${getCurrentMonth()}`;
    try {
      const alreadySent = await kv.get(warningKey);
      if (alreadySent) {
        return; // Already warned this month
      }
    } catch {
      // Continue if KV fails
    }

    // Get quota info
    const quota = await db
      .prepare('SELECT * FROM token_quotas WHERE tenant_id = ?')
      .bind(tenantId)
      .first<TokenQuota>();

    if (!quota) {
      return; // No quota configured
    }

    const current = await this.getMonthlyUsage(db, kv, tenantId);
    const usagePercent = (current / quota.monthly_limit) * 100;

    // Only send if at or above warning threshold (default 80%)
    if (usagePercent < quota.warning_threshold * 100) {
      return;
    }

    // Get tenant admin phone number (from tenants table)
    const tenant = await db
      .prepare('SELECT phone_number FROM tenants WHERE id = ?')
      .bind(tenantId)
      .first<{ phone_number: string }>();

    if (!tenant?.phone_number) {
      return; // No admin phone to send to
    }

    // Send warning via Go-Wa
    const message = `⚠️ AI Token Usage Warning\n\nYour AI token usage has reached ${Math.round(usagePercent)}% of your monthly limit.\n\nUsed: ${current.toLocaleString()} tokens\nLimit: ${quota.monthly_limit.toLocaleString()} tokens\n\nPlease consider upgrading your plan or reducing AI usage to avoid service interruption.`;

    try {
      await fetch(`${gowaBaseUrl}/send/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${gowaApiKey}`,
        },
        body: JSON.stringify({
          phone: tenant.phone_number,
          message,
        }),
      });

      // Mark warning as sent for this month
      await kv.put(warningKey, '1', { expirationTtl: 30 * 24 * 3600 });
    } catch (error) {
      console.error('[TokenTrackerService] Failed to send quota warning:', error);
    }
  }
}


// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the KV key for the monthly token usage counter.
 * Pattern: token_usage:{tenant_id}:{YYYY-MM}
 */
function getMonthlyKey(tenantId: string): string {
  return `${TOKEN_USAGE_CACHE_PREFIX}${tenantId}:${getCurrentMonth()}`;
}

/**
 * Get current month string in YYYY-MM format.
 */
function getCurrentMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Get the first day of the current month as ISO string.
 */
function getMonthStartDate(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01T00:00:00`;
}
