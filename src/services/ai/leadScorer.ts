/**
 * Lead Scorer Service for AI Sales Agent.
 * Scores contacts based on configurable factors (keywords, patterns),
 * maps to hot/warm/cold categories, and caches results in KV.
 *
 * Requirements: 12.4
 */

import type { LeadScoreRecord, LeadScore } from '../../types/ai';

/** KV cache key pattern for lead scores */
const LEAD_SCORE_CACHE_PREFIX = 'lead_score:';

/** TTL for lead score cache in seconds */
const LEAD_SCORE_CACHE_TTL = 300;

/** Score thresholds for category mapping */
const SCORE_THRESHOLD_HOT = 80;
const SCORE_THRESHOLD_WARM = 40;


/** Scoring factor configuration from D1 */
interface ScoringFactor {
  id: string;
  tenant_id: string;
  factor_type: 'keyword' | 'pattern' | 'timing' | 'engagement';
  factor_config: string; // JSON
  weight: number;
  active: number;
}

/**
 * LeadScorerService provides contact scoring based on configurable factors.
 * Scores are cached in KV with 300s TTL for performance.
 */
export class LeadScorerService {
  private db: D1Database;
  private kv: KVNamespace;

  constructor(db: D1Database, kv: KVNamespace) {
    this.db = db;
    this.kv = kv;
  }


  /**
   * Score a contact based on message content against configured scoring factors.
   *
   * Logic:
   * 1. Load active scoring factors from lead_scoring_config WHERE tenant_id=? AND active=1
   * 2. For each factor: if message contains keyword/pattern, add weight to score
   * 3. Map numeric score to category: >= 80 = 'hot', >= 40 = 'warm', < 40 = 'cold'
   * 4. Update lead_scores table (upsert)
   * 5. Cache result in KV with 300s TTL
   *
   * @param tenantId - The tenant owning the contact
   * @param contactId - The contact to score
   * @param messageContent - The message content to analyze
   * @returns The updated LeadScoreRecord
   */
  async scoreContact(
    tenantId: string,
    contactId: string,
    messageContent: string
  ): Promise<LeadScoreRecord> {
    // Step 1: Load active scoring factors
    const factorsResult = await this.db
      .prepare(
        `SELECT * FROM lead_scoring_config WHERE tenant_id = ? AND active = 1`
      )
      .bind(tenantId)
      .all<ScoringFactor>();

    const factors = factorsResult.results ?? [];

    // Step 2: Calculate numeric score
    let numericScore = 0;
    const matchedFactors: Array<{ factor_id: string; type: string; weight: number }> = [];
    const lowerContent = messageContent.toLowerCase();

    for (const factor of factors) {
      let matched = false;

      try {
        const config = JSON.parse(factor.factor_config) as Record<string, unknown>;

        if (factor.factor_type === 'keyword') {
          // Check if message contains any of the keywords
          const keywords = (config.keywords as string[]) ?? [];
          matched = keywords.some((kw) => lowerContent.includes(kw.toLowerCase()));
        } else if (factor.factor_type === 'pattern') {
          // Check if message matches regex pattern
          const pattern = config.pattern as string;
          if (pattern) {
            const regex = new RegExp(pattern, 'i');
            matched = regex.test(messageContent);
          }
        }
      } catch {
        // Skip invalid factor config
        continue;
      }

      if (matched) {
        numericScore += factor.weight;
        matchedFactors.push({
          factor_id: factor.id,
          type: factor.factor_type,
          weight: factor.weight,
        });
      }
    }

    // Step 3: Map to category
    const score = mapScoreToCategory(numericScore);

    // Step 4: Upsert lead_scores table
    const now = new Date().toISOString();
    const scoringFactorsJson = JSON.stringify(matchedFactors);

    const existing = await this.db
      .prepare(
        'SELECT id FROM lead_scores WHERE tenant_id = ? AND contact_id = ?'
      )
      .bind(tenantId, contactId)
      .first<{ id: string }>();

    let record: LeadScoreRecord;

    if (existing) {
      await this.db
        .prepare(
          `UPDATE lead_scores SET score = ?, numeric_score = ?, scoring_factors = ?, last_scored_at = ?
           WHERE id = ? AND tenant_id = ?`
        )
        .bind(score, numericScore, scoringFactorsJson, now, existing.id, tenantId)
        .run();

      record = {
        id: existing.id,
        tenant_id: tenantId,
        contact_id: contactId,
        score,
        numeric_score: numericScore,
        scoring_factors: scoringFactorsJson,
        last_scored_at: now,
      };
    } else {
      const id = crypto.randomUUID();
      await this.db
        .prepare(
          `INSERT INTO lead_scores (id, tenant_id, contact_id, score, numeric_score, scoring_factors, last_scored_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(id, tenantId, contactId, score, numericScore, scoringFactorsJson, now)
        .run();

      record = {
        id,
        tenant_id: tenantId,
        contact_id: contactId,
        score,
        numeric_score: numericScore,
        scoring_factors: scoringFactorsJson,
        last_scored_at: now,
      };
    }

    // Step 5: Cache in KV
    const cacheKey = `${LEAD_SCORE_CACHE_PREFIX}${tenantId}:${contactId}`;
    try {
      await this.kv.put(cacheKey, JSON.stringify(record), {
        expirationTtl: LEAD_SCORE_CACHE_TTL,
      });
    } catch (error) {
      console.error('[LeadScorerService] KV cache write failed:', error);
    }

    return record;
  }


  /**
   * Get the current lead score for a contact.
   * Checks KV cache first, falls back to D1 on cache miss.
   *
   * @param tenantId - The tenant owning the contact
   * @param contactId - The contact to get score for
   * @returns The LeadScoreRecord or null if not scored yet
   */
  async getScore(tenantId: string, contactId: string): Promise<LeadScoreRecord | null> {
    const cacheKey = `${LEAD_SCORE_CACHE_PREFIX}${tenantId}:${contactId}`;

    // Check KV cache first
    try {
      const cached = await this.kv.get(cacheKey);
      if (cached !== null) {
        return JSON.parse(cached) as LeadScoreRecord;
      }
    } catch (error) {
      console.error('[LeadScorerService] KV cache read failed:', error);
    }

    // Fallback to D1
    const result = await this.db
      .prepare(
        'SELECT * FROM lead_scores WHERE tenant_id = ? AND contact_id = ?'
      )
      .bind(tenantId, contactId)
      .first<LeadScoreRecord>();

    if (!result) {
      return null;
    }

    // Populate cache for next read
    try {
      await this.kv.put(cacheKey, JSON.stringify(result), {
        expirationTtl: LEAD_SCORE_CACHE_TTL,
      });
    } catch (error) {
      console.error('[LeadScorerService] KV cache write failed:', error);
    }

    return result;
  }

  /**
   * Configure scoring factors for a tenant.
   * Saves scoring criteria to the lead_scoring_config table.
   *
   * @param tenantId - The tenant configuring scoring
   * @param factors - Array of scoring factor configurations
   * @returns Array of saved scoring factor records
   */
  async configureScoring(
    tenantId: string,
    factors: Array<{
      factor_type: 'keyword' | 'pattern' | 'timing' | 'engagement';
      factor_config: Record<string, unknown>;
      weight: number;
    }>
  ): Promise<ScoringFactor[]> {
    // Deactivate existing factors for this tenant
    await this.db
      .prepare('UPDATE lead_scoring_config SET active = 0 WHERE tenant_id = ?')
      .bind(tenantId)
      .run();

    const savedFactors: ScoringFactor[] = [];

    for (const factor of factors) {
      const id = crypto.randomUUID();
      const configJson = JSON.stringify(factor.factor_config);

      await this.db
        .prepare(
          `INSERT INTO lead_scoring_config (id, tenant_id, factor_type, factor_config, weight, active)
           VALUES (?, ?, ?, ?, ?, 1)`
        )
        .bind(id, tenantId, factor.factor_type, configJson, factor.weight)
        .run();

      savedFactors.push({
        id,
        tenant_id: tenantId,
        factor_type: factor.factor_type,
        factor_config: configJson,
        weight: factor.weight,
        active: 1,
      });
    }

    return savedFactors;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Maps a numeric score to a lead category.
 * >= 80 = 'hot', >= 40 = 'warm', < 40 = 'cold'
 */
function mapScoreToCategory(numericScore: number): LeadScore {
  if (numericScore >= SCORE_THRESHOLD_HOT) {
    return 'hot';
  }
  if (numericScore >= SCORE_THRESHOLD_WARM) {
    return 'warm';
  }
  return 'cold';
}
