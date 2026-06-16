/**
 * Guardrail Engine Service.
 * Validates AI-generated responses against tenant-configured business rules
 * and detects potential hallucinations.
 *
 * Requirements: 3.5, 8.1, 8.2, 8.3, 8.6
 */

import type { BusinessRule, GuardrailResult, GuardrailViolation } from '../../types/ai';

// ============================================================================
// Public API
// ============================================================================

/**
 * Validates an AI-generated response against all active business rules for a tenant.
 * Checks: prohibited phrases, restricted topics, max discount enforcement, required disclaimers.
 * Skips rules of type 'custom' (reserved for future extensibility).
 *
 * @param db - D1 database binding
 * @param tenantId - The tenant ID (all queries are tenant-scoped)
 * @param response - The AI-generated response text to validate
 * @param context - Context including KB entries and conversation messages
 * @returns GuardrailResult with passed status and any violations
 */
export async function validateResponse(
  db: D1Database,
  tenantId: string,
  response: string,
  context: { kbEntries: Array<{ content: string }>; conversationMessages: string[] }
): Promise<GuardrailResult> {
  // Load all active business rules for the tenant, ordered by priority
  const rulesResult = await db
    .prepare(
      `SELECT id, tenant_id, rule_type, rule_name, rule_config, active, priority, created_at, updated_at
       FROM business_rules
       WHERE tenant_id = ? AND active = 1
       ORDER BY priority DESC`
    )
    .bind(tenantId)
    .all<BusinessRule>();

  const rules = rulesResult.results ?? [];
  const violations: GuardrailViolation[] = [];

  // Check each rule against the response
  for (const rule of rules) {
    const violation = checkRule(rule, response);
    if (violation) {
      violations.push(violation);
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

/**
 * Simple hallucination detection.
 * Checks if the AI response makes claims about prices or features that are not
 * found in the KB entries or conversation context.
 *
 * This uses heuristic matching — it extracts specific factual claims (prices, percentages,
 * feature names with "fitur"/"feature" prefix) and verifies they can be traced back
 * to the provided knowledge base entries or recent conversation messages.
 *
 * @param response - The AI-generated response text
 * @param kbEntries - Array of knowledge base entry content strings
 * @param conversationContext - Array of recent conversation message strings
 * @returns true if a potential hallucination is detected, false otherwise
 */
export function detectHallucination(
  response: string,
  kbEntries: string[],
  conversationContext: string[]
): boolean {
  // Combine all reference material into one searchable corpus
  const referenceCorpus = [...kbEntries, ...conversationContext].join(' ').toLowerCase();

  // If there's no reference material, we can't detect hallucinations
  if (referenceCorpus.trim().length === 0) {
    return false;
  }

  // Extract price claims from the response (e.g., "Rp 100.000", "Rp100000", "$50")
  const priceClaims = extractPriceClaims(response);
  for (const price of priceClaims) {
    // Check if this price appears anywhere in the reference corpus
    if (!referenceCorpus.includes(price.toLowerCase())) {
      // Try normalized numeric comparison
      const numericValue = extractNumericFromPrice(price);
      if (numericValue !== null) {
        const foundInCorpus = findNumericPriceInCorpus(numericValue, referenceCorpus);
        if (!foundInCorpus) {
          return true; // Price claim not backed by references
        }
      } else {
        return true; // Can't normalize — treat as potential hallucination
      }
    }
  }

  // Extract percentage/discount claims from the response
  const percentages = extractDiscountPercentages(response);
  for (const pct of percentages) {
    const pctStr = `${pct}%`;
    const pctStrAlt = `${pct} %`;
    const pctStrWord = `${pct} persen`;
    if (
      !referenceCorpus.includes(pctStr) &&
      !referenceCorpus.includes(pctStrAlt) &&
      !referenceCorpus.includes(pctStrWord)
    ) {
      return true; // Percentage claim not backed by references
    }
  }

  // Extract feature claims (words after "fitur" or "feature")
  const featureClaims = extractFeatureClaims(response);
  for (const feature of featureClaims) {
    if (!referenceCorpus.includes(feature.toLowerCase())) {
      return true; // Feature claim not backed by references
    }
  }

  return false;
}

/**
 * Extracts discount percentages from text using regex.
 * Matches patterns like "10%", "10 %", "diskon 15%", "discount 20%", "10 persen".
 *
 * @param text - The text to search for discount percentages
 * @returns Array of numeric percentage values found
 */
export function extractDiscountPercentages(text: string): number[] {
  const percentages: number[] = [];

  // Match patterns: "10%", "10 %", "10persen", "10 persen", "10percent", "10 percent"
  const patterns = [
    /(\d+(?:\.\d+)?)\s*%/g,
    /(\d+(?:\.\d+)?)\s*persen/gi,
    /(\d+(?:\.\d+)?)\s*percent/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const captured = match[1] ?? '';
      const value = parseFloat(captured);
      if (!isNaN(value) && !percentages.includes(value)) {
        percentages.push(value);
      }
    }
  }

  return percentages;
}

// ============================================================================
// Internal Helper Functions
// ============================================================================

/**
 * Checks a single business rule against the AI response.
 * Returns a violation if the rule is violated, null otherwise.
 */
function checkRule(rule: BusinessRule, response: string): GuardrailViolation | null {
  const config = parseRuleConfig(rule.rule_config);

  switch (rule.rule_type) {
    case 'prohibited_phrase':
      return checkProhibitedPhrase(rule, response, config);

    case 'restricted_topic':
      return checkRestrictedTopic(rule, response, config);

    case 'max_discount':
      return checkMaxDiscount(rule, response, config);

    case 'required_disclaimer':
      return checkRequiredDisclaimer(rule, response, config);

    case 'custom':
      // Skip custom rules — reserved for future extensibility
      return null;

    default:
      return null;
  }
}

/**
 * Checks if the response contains any prohibited phrases (case-insensitive).
 * rule_config expected format: { "phrases": ["phrase1", "phrase2", ...] }
 */
function checkProhibitedPhrase(
  rule: BusinessRule,
  response: string,
  config: Record<string, unknown>
): GuardrailViolation | null {
  const phrases = config.phrases as string[] | undefined;
  if (!phrases || !Array.isArray(phrases)) {
    return null;
  }

  const responseLower = response.toLowerCase();

  for (const phrase of phrases) {
    if (typeof phrase === 'string' && responseLower.includes(phrase.toLowerCase())) {
      return {
        rule_id: rule.id,
        rule_type: rule.rule_type,
        rule_name: rule.rule_name,
        violation_detail: `Response contains prohibited phrase: "${phrase}"`,
      };
    }
  }

  return null;
}

/**
 * Checks if the response mentions restricted topics (case-insensitive keyword matching).
 * rule_config expected format: { "topics": ["topic1", "topic2", ...] }
 * or { "keywords": ["keyword1", "keyword2", ...] }
 */
function checkRestrictedTopic(
  rule: BusinessRule,
  response: string,
  config: Record<string, unknown>
): GuardrailViolation | null {
  const topics = (config.topics ?? config.keywords) as string[] | undefined;
  if (!topics || !Array.isArray(topics)) {
    return null;
  }

  const responseLower = response.toLowerCase();

  for (const topic of topics) {
    if (typeof topic === 'string' && responseLower.includes(topic.toLowerCase())) {
      return {
        rule_id: rule.id,
        rule_type: rule.rule_type,
        rule_name: rule.rule_name,
        violation_detail: `Response mentions restricted topic: "${topic}"`,
      };
    }
  }

  return null;
}

/**
 * Checks if any discount percentages in the response exceed the configured max.
 * rule_config expected format: { "max_percent": 20 }
 */
function checkMaxDiscount(
  rule: BusinessRule,
  response: string,
  config: Record<string, unknown>
): GuardrailViolation | null {
  const maxPercent = config.max_percent as number | undefined;
  if (maxPercent === undefined || typeof maxPercent !== 'number') {
    return null;
  }

  const discounts = extractDiscountPercentages(response);

  for (const discount of discounts) {
    if (discount > maxPercent) {
      return {
        rule_id: rule.id,
        rule_type: rule.rule_type,
        rule_name: rule.rule_name,
        violation_detail: `Response offers ${discount}% discount, exceeding maximum allowed ${maxPercent}%`,
      };
    }
  }

  return null;
}

/**
 * Checks if required disclaimers are present when relevant keywords appear in the response.
 * rule_config expected format: { "keywords": ["garansi", "warranty"], "disclaimer": "Syarat dan ketentuan berlaku." }
 */
function checkRequiredDisclaimer(
  rule: BusinessRule,
  response: string,
  config: Record<string, unknown>
): GuardrailViolation | null {
  const keywords = config.keywords as string[] | undefined;
  const disclaimer = config.disclaimer as string | undefined;

  if (!keywords || !Array.isArray(keywords) || !disclaimer) {
    return null;
  }

  const responseLower = response.toLowerCase();

  // Check if any trigger keywords are present
  const keywordFound = keywords.some(
    (keyword) => typeof keyword === 'string' && responseLower.includes(keyword.toLowerCase())
  );

  if (!keywordFound) {
    // No trigger keywords in response — disclaimer not needed
    return null;
  }

  // Keywords present — check if disclaimer is included
  if (!responseLower.includes(disclaimer.toLowerCase())) {
    return {
      rule_id: rule.id,
      rule_type: rule.rule_type,
      rule_name: rule.rule_name,
      violation_detail: `Response mentions keywords [${keywords.join(', ')}] but is missing required disclaimer: "${disclaimer}"`,
    };
  }

  return null;
}

/**
 * Safely parses rule_config JSON string into an object.
 * Returns an empty object on parse failure.
 */
function parseRuleConfig(configStr: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(configStr);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Extracts price claims from text.
 * Matches formats: "Rp 100.000", "Rp100.000", "Rp 100,000", "$50", "IDR 100000"
 */
function extractPriceClaims(text: string): string[] {
  const claims: string[] = [];

  // Rp format: "Rp", optional space, then digits possibly with dots/commas
  const rpPattern = /Rp\.?\s*([\d.,]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = rpPattern.exec(text)) !== null) {
    claims.push(`Rp ${match[1]}`);
  }

  // IDR format
  const idrPattern = /IDR\s*([\d.,]+)/gi;
  while ((match = idrPattern.exec(text)) !== null) {
    claims.push(`IDR ${match[1]}`);
  }

  // Dollar format
  const dollarPattern = /\$\s*([\d.,]+)/g;
  while ((match = dollarPattern.exec(text)) !== null) {
    claims.push(`$${match[1]}`);
  }

  return claims;
}

/**
 * Extracts the numeric value from a price string.
 * Removes currency symbols, dots (as thousands separators), commas, and spaces.
 */
function extractNumericFromPrice(priceStr: string): number | null {
  // Remove currency prefix (Rp, IDR, $)
  const cleaned = priceStr
    .replace(/^(Rp\.?\s*|IDR\s*|\$\s*)/i, '')
    .replace(/\./g, '') // Remove dots (thousands separator in Indonesian)
    .replace(/,/g, '')  // Remove commas
    .trim();

  const value = parseInt(cleaned, 10);
  return isNaN(value) ? null : value;
}

/**
 * Searches for a numeric price value in the reference corpus.
 * Tries various formats (with/without thousands separators).
 */
function findNumericPriceInCorpus(numericValue: number, corpus: string): boolean {
  // Try plain number
  if (corpus.includes(String(numericValue))) {
    return true;
  }

  // Try with dot thousands separator (Indonesian format: 100.000)
  const formatted = numericValue.toLocaleString('id-ID');
  if (corpus.includes(formatted)) {
    return true;
  }

  // Try with comma thousands separator (100,000)
  const formattedEN = numericValue.toLocaleString('en-US');
  if (corpus.includes(formattedEN)) {
    return true;
  }

  return false;
}

/**
 * Extracts feature claims from text.
 * Looks for words following "fitur" or "feature" keywords.
 */
function extractFeatureClaims(text: string): string[] {
  const claims: string[] = [];

  // Match "fitur <word>" or "feature <word>" patterns
  const featurePattern = /(?:fitur|feature)\s+([a-zA-Z0-9_-]+(?:\s+[a-zA-Z0-9_-]+)?)/gi;
  let match: RegExpExecArray | null;
  while ((match = featurePattern.exec(text)) !== null) {
    const claim = (match[1] ?? '').trim();
    if (claim && !claims.includes(claim)) {
      claims.push(claim);
    }
  }

  return claims;
}
