/**
 * Unit tests for GuardrailEngine service.
 * Validates Requirements: 3.5, 8.1, 8.2, 8.3, 8.6
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createMockD1 } from '../../../helpers';
import {
  validateResponse,
  detectHallucination,
  extractDiscountPercentages,
} from '../../../../src/services/ai/guardrails';

describe('GuardrailEngine - validateResponse', () => {
  let mockDb: ReturnType<typeof createMockD1>;
  const tenantId = 'tenant-001';
  const defaultContext = {
    kbEntries: [{ content: 'Product A costs Rp 100.000' }],
    conversationMessages: ['Hello, how can I help?'],
  };

  beforeEach(() => {
    mockDb = createMockD1();
  });

  // ==========================================================================
  // No rules configured
  // ==========================================================================

  describe('No rules configured', () => {
    it('should pass when no business rules exist', async () => {
      mockDb._setNextResults([]); // No rules

      const result = await validateResponse(
        mockDb as unknown as D1Database,
        tenantId,
        'Hello! How can I help you today?',
        defaultContext
      );

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Prohibited phrases
  // ==========================================================================

  describe('prohibited_phrase rule', () => {
    it('should detect prohibited phrase (case-insensitive)', async () => {
      mockDb._setNextResults([
        {
          id: 'rule-001',
          tenant_id: tenantId,
          rule_type: 'prohibited_phrase',
          rule_name: 'No competitor mentions',
          rule_config: JSON.stringify({ phrases: ['competitor brand', 'rival product'] }),
          active: 1,
          priority: 10,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]);

      const result = await validateResponse(
        mockDb as unknown as D1Database,
        tenantId,
        'Our product is better than COMPETITOR BRAND in every way.',
        defaultContext
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].rule_id).toBe('rule-001');
      expect(result.violations[0].rule_type).toBe('prohibited_phrase');
      expect(result.violations[0].violation_detail).toContain('competitor brand');
    });

    it('should pass when no prohibited phrases are found', async () => {
      mockDb._setNextResults([
        {
          id: 'rule-001',
          tenant_id: tenantId,
          rule_type: 'prohibited_phrase',
          rule_name: 'No competitor mentions',
          rule_config: JSON.stringify({ phrases: ['competitor brand', 'rival product'] }),
          active: 1,
          priority: 10,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]);

      const result = await validateResponse(
        mockDb as unknown as D1Database,
        tenantId,
        'Our product is the best in its class!',
        defaultContext
      );

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Restricted topics
  // ==========================================================================

  describe('restricted_topic rule', () => {
    it('should detect restricted topic mentions', async () => {
      mockDb._setNextResults([
        {
          id: 'rule-002',
          tenant_id: tenantId,
          rule_type: 'restricted_topic',
          rule_name: 'No politics',
          rule_config: JSON.stringify({ topics: ['politik', 'election', 'partai'] }),
          active: 1,
          priority: 5,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]);

      const result = await validateResponse(
        mockDb as unknown as D1Database,
        tenantId,
        'Berbicara soal Politik, menurut saya presiden saat ini...',
        defaultContext
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].rule_type).toBe('restricted_topic');
      expect(result.violations[0].violation_detail).toContain('politik');
    });

    it('should support "keywords" config field as alternative to "topics"', async () => {
      mockDb._setNextResults([
        {
          id: 'rule-002',
          tenant_id: tenantId,
          rule_type: 'restricted_topic',
          rule_name: 'No religion',
          rule_config: JSON.stringify({ keywords: ['agama', 'religion'] }),
          active: 1,
          priority: 5,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]);

      const result = await validateResponse(
        mockDb as unknown as D1Database,
        tenantId,
        'Menurut agama saya, hal tersebut...',
        defaultContext
      );

      expect(result.passed).toBe(false);
      expect(result.violations[0].violation_detail).toContain('agama');
    });
  });

  // ==========================================================================
  // Max discount
  // ==========================================================================

  describe('max_discount rule', () => {
    it('should detect discount exceeding maximum', async () => {
      mockDb._setNextResults([
        {
          id: 'rule-003',
          tenant_id: tenantId,
          rule_type: 'max_discount',
          rule_name: 'Max 20% discount',
          rule_config: JSON.stringify({ max_percent: 20 }),
          active: 1,
          priority: 10,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]);

      const result = await validateResponse(
        mockDb as unknown as D1Database,
        tenantId,
        'Saya bisa berikan diskon spesial 30% untuk Anda hari ini!',
        defaultContext
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].rule_type).toBe('max_discount');
      expect(result.violations[0].violation_detail).toContain('30%');
      expect(result.violations[0].violation_detail).toContain('20%');
    });

    it('should pass when discount is within limits', async () => {
      mockDb._setNextResults([
        {
          id: 'rule-003',
          tenant_id: tenantId,
          rule_type: 'max_discount',
          rule_name: 'Max 20% discount',
          rule_config: JSON.stringify({ max_percent: 20 }),
          active: 1,
          priority: 10,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]);

      const result = await validateResponse(
        mockDb as unknown as D1Database,
        tenantId,
        'Saya bisa berikan diskon 15% untuk pembelian hari ini.',
        defaultContext
      );

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should pass when discount equals the maximum exactly', async () => {
      mockDb._setNextResults([
        {
          id: 'rule-003',
          tenant_id: tenantId,
          rule_type: 'max_discount',
          rule_name: 'Max 20% discount',
          rule_config: JSON.stringify({ max_percent: 20 }),
          active: 1,
          priority: 10,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]);

      const result = await validateResponse(
        mockDb as unknown as D1Database,
        tenantId,
        'Diskon maksimal yang bisa kami berikan adalah 20%.',
        defaultContext
      );

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should detect "persen" keyword discount', async () => {
      mockDb._setNextResults([
        {
          id: 'rule-003',
          tenant_id: tenantId,
          rule_type: 'max_discount',
          rule_name: 'Max 10% discount',
          rule_config: JSON.stringify({ max_percent: 10 }),
          active: 1,
          priority: 10,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]);

      const result = await validateResponse(
        mockDb as unknown as D1Database,
        tenantId,
        'Kami berikan 25 persen diskon untuk order diatas 1 juta.',
        defaultContext
      );

      expect(result.passed).toBe(false);
      expect(result.violations[0].violation_detail).toContain('25%');
    });
  });

  // ==========================================================================
  // Required disclaimers
  // ==========================================================================

  describe('required_disclaimer rule', () => {
    it('should detect missing disclaimer when keywords are present', async () => {
      mockDb._setNextResults([
        {
          id: 'rule-004',
          tenant_id: tenantId,
          rule_type: 'required_disclaimer',
          rule_name: 'Warranty disclaimer',
          rule_config: JSON.stringify({
            keywords: ['garansi', 'warranty'],
            disclaimer: 'Syarat dan ketentuan berlaku.',
          }),
          active: 1,
          priority: 5,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]);

      const result = await validateResponse(
        mockDb as unknown as D1Database,
        tenantId,
        'Produk ini memiliki garansi 1 tahun penuh.',
        defaultContext
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].rule_type).toBe('required_disclaimer');
      expect(result.violations[0].violation_detail).toContain('garansi');
      expect(result.violations[0].violation_detail).toContain('Syarat dan ketentuan berlaku.');
    });

    it('should pass when disclaimer is present with keywords', async () => {
      mockDb._setNextResults([
        {
          id: 'rule-004',
          tenant_id: tenantId,
          rule_type: 'required_disclaimer',
          rule_name: 'Warranty disclaimer',
          rule_config: JSON.stringify({
            keywords: ['garansi', 'warranty'],
            disclaimer: 'Syarat dan ketentuan berlaku.',
          }),
          active: 1,
          priority: 5,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]);

      const result = await validateResponse(
        mockDb as unknown as D1Database,
        tenantId,
        'Produk ini memiliki garansi 1 tahun. Syarat dan ketentuan berlaku.',
        defaultContext
      );

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should pass when trigger keywords are not present', async () => {
      mockDb._setNextResults([
        {
          id: 'rule-004',
          tenant_id: tenantId,
          rule_type: 'required_disclaimer',
          rule_name: 'Warranty disclaimer',
          rule_config: JSON.stringify({
            keywords: ['garansi', 'warranty'],
            disclaimer: 'Syarat dan ketentuan berlaku.',
          }),
          active: 1,
          priority: 5,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]);

      const result = await validateResponse(
        mockDb as unknown as D1Database,
        tenantId,
        'Produk ini bagus sekali dan berkualitas tinggi.',
        defaultContext
      );

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Custom rules (skipped)
  // ==========================================================================

  describe('custom rule type', () => {
    it('should skip custom rules without violation', async () => {
      mockDb._setNextResults([
        {
          id: 'rule-005',
          tenant_id: tenantId,
          rule_type: 'custom',
          rule_name: 'Future rule',
          rule_config: JSON.stringify({ custom_logic: 'some_future_handler' }),
          active: 1,
          priority: 1,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]);

      const result = await validateResponse(
        mockDb as unknown as D1Database,
        tenantId,
        'Any response should pass custom rules.',
        defaultContext
      );

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Multiple rules
  // ==========================================================================

  describe('Multiple rules', () => {
    it('should collect multiple violations from different rules', async () => {
      mockDb._setNextResults([
        {
          id: 'rule-001',
          tenant_id: tenantId,
          rule_type: 'prohibited_phrase',
          rule_name: 'No competitor mentions',
          rule_config: JSON.stringify({ phrases: ['competitor X'] }),
          active: 1,
          priority: 10,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
        {
          id: 'rule-003',
          tenant_id: tenantId,
          rule_type: 'max_discount',
          rule_name: 'Max 15% discount',
          rule_config: JSON.stringify({ max_percent: 15 }),
          active: 1,
          priority: 5,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]);

      const result = await validateResponse(
        mockDb as unknown as D1Database,
        tenantId,
        'Unlike competitor X, we offer 50% discount on all items!',
        defaultContext
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(2);
      expect(result.violations.map((v) => v.rule_type)).toContain('prohibited_phrase');
      expect(result.violations.map((v) => v.rule_type)).toContain('max_discount');
    });
  });

  // ==========================================================================
  // Malformed rule config
  // ==========================================================================

  describe('Malformed rule config', () => {
    it('should handle malformed JSON in rule_config gracefully', async () => {
      mockDb._setNextResults([
        {
          id: 'rule-bad',
          tenant_id: tenantId,
          rule_type: 'prohibited_phrase',
          rule_name: 'Bad config',
          rule_config: '{invalid json',
          active: 1,
          priority: 1,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]);

      const result = await validateResponse(
        mockDb as unknown as D1Database,
        tenantId,
        'Any response text.',
        defaultContext
      );

      // Should not crash, should pass with no violations
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });
});

// ============================================================================
// detectHallucination tests
// ============================================================================

describe('GuardrailEngine - detectHallucination', () => {
  it('should return false when no reference material is available', () => {
    const result = detectHallucination(
      'Product costs Rp 100.000',
      [],
      []
    );
    expect(result).toBe(false);
  });

  it('should return false when price claims match KB entries', () => {
    const result = detectHallucination(
      'Produk A harganya Rp 100.000',
      ['Produk A harganya Rp 100.000 dan tersedia dalam warna merah.'],
      []
    );
    expect(result).toBe(false);
  });

  it('should return true when price is not found in reference material', () => {
    const result = detectHallucination(
      'Produk A harganya Rp 500.000',
      ['Produk A harganya Rp 100.000'],
      []
    );
    expect(result).toBe(true);
  });

  it('should check conversation context as well as KB entries', () => {
    const result = detectHallucination(
      'Diskon 10% tersedia hari ini.',
      [],
      ['Kami berikan diskon 10% untuk pembelian pertama.']
    );
    expect(result).toBe(false);
  });

  it('should detect hallucinated percentage not in references', () => {
    const result = detectHallucination(
      'Kami punya diskon 50% hari ini!',
      ['Produk A Rp 100.000, diskon 10%'],
      ['Diskon maksimal 10%']
    );
    expect(result).toBe(true);
  });

  it('should detect hallucinated feature claims', () => {
    const result = detectHallucination(
      'Produk ini memiliki fitur waterproof yang sangat bagus.',
      ['Produk B memiliki fitur anti-gores dan tahan banting.'],
      []
    );
    expect(result).toBe(true);
  });

  it('should pass when feature claim matches KB entries', () => {
    const result = detectHallucination(
      'Produk ini memiliki fitur waterproof.',
      ['Produk ini dilengkapi fitur waterproof dan tahan debu.'],
      []
    );
    expect(result).toBe(false);
  });
});

// ============================================================================
// extractDiscountPercentages tests
// ============================================================================

describe('GuardrailEngine - extractDiscountPercentages', () => {
  it('should extract percentage with % symbol', () => {
    const result = extractDiscountPercentages('Diskon 20% untuk Anda');
    expect(result).toEqual([20]);
  });

  it('should extract percentage with space before %', () => {
    const result = extractDiscountPercentages('Diskon 15 %');
    expect(result).toEqual([15]);
  });

  it('should extract "persen" keyword', () => {
    const result = extractDiscountPercentages('Kami berikan 10 persen');
    expect(result).toEqual([10]);
  });

  it('should extract "percent" keyword', () => {
    const result = extractDiscountPercentages('Get 25 percent off');
    expect(result).toEqual([25]);
  });

  it('should extract multiple percentages', () => {
    const result = extractDiscountPercentages('Diskon 10% sampai 30% tersedia');
    expect(result).toEqual([10, 30]);
  });

  it('should handle decimal percentages', () => {
    const result = extractDiscountPercentages('Diskon 12.5% hari ini');
    expect(result).toEqual([12.5]);
  });

  it('should return empty array when no percentages found', () => {
    const result = extractDiscountPercentages('Tidak ada diskon saat ini.');
    expect(result).toEqual([]);
  });

  it('should not duplicate percentages found by multiple patterns', () => {
    const result = extractDiscountPercentages('10% off (10 percent)');
    expect(result).toEqual([10]);
  });
});
