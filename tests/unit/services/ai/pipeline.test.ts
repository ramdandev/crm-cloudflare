/**
 * Unit tests for AIPipelineService (core orchestrator).
 * Validates Requirements: 3.1, 3.4, 3.5, 3.6, 4.1, 4.3
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createMockKV, createMockD1, createMockR2, createMockQueue } from '../../../helpers';
import { processAIMessage } from '../../../../src/services/ai/pipeline';
import type { AIProcessingJob } from '../../../../src/types/ai';
import type { Bindings } from '../../../../src/types/bindings';

describe('AIPipelineService - processAIMessage', () => {
  let mockDb: ReturnType<typeof createMockD1>;
  let mockKv: KVNamespace;
  let mockR2: R2Bucket;
  let mockEnv: Bindings;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const baseJob: AIProcessingJob = {
    tenant_id: 'tenant-001',
    contact_id: 'contact-001',
    message_id: 'msg-001',
    sender_phone: '6281234567890',
    message_content: 'Halo, saya mau tanya tentang produk',
    message_type: 'text',
  };

  const mockAIConfig = {
    id: 'cfg-001',
    tenant_id: 'tenant-001',
    provider_url: 'https://api.openai.com/v1',
    model_name: 'gpt-4o-mini',
    api_key_encrypted: '', // Will be set in beforeEach
    system_prompt: 'You are a helpful AI sales agent.',
    temperature: 0.7,
    max_tokens: 1024,
    context_window: 20,
    language: 'id',
    tone: 'friendly_professional',
    confidence_threshold: 0.7,
    active: 1,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockDb = createMockD1();
    mockKv = createMockKV();
    mockR2 = createMockR2();

    mockEnv = {
      DB: mockDb as unknown as D1Database,
      KV: mockKv,
      R2: mockR2,
      BROADCAST_QUEUE: createMockQueue() as unknown as Queue,
      AI_QUEUE: createMockQueue() as unknown as Queue,
      REMINDER_QUEUE: createMockQueue() as unknown as Queue,
      CLERK_SECRET_KEY: 'test-clerk-key',
      GOWA_BASE_URL: 'https://gowa.test.local',
      GOWA_API_KEY: 'test-gowa-key',
      META_ACCESS_TOKEN: 'test-meta-token',
      META_PHONE_NUMBER_ID: 'test-phone-id',
      IPAYMU_API_KEY: 'test-ipaymu-key',
      IPAYMU_VA: 'test-va',
      IPAYMU_SECRET: 'test-secret',
      ENCRYPTION_KEY: 'test-encryption-key-32chars-long!',
    };

    // Pre-seed the KV with a valid config (simulating getConfig cache hit)
    // We need to encrypt a test API key first
    const { encryptApiKey } = await import('../../../../src/services/ai/config');
    const encryptedKey = await encryptApiKey('sk-test-key-12345', mockEnv.ENCRYPTION_KEY);
    const configWithKey = { ...mockAIConfig, api_key_encrypted: encryptedKey };
    await mockKv.put(`ai_config:tenant-001`, JSON.stringify(configWithKey));
  });

  afterEach(() => {
    if (fetchSpy) {
      fetchSpy.mockRestore();
    }
  });

  // ==========================================================================
  // Step 1: Config check
  // ==========================================================================

  describe('Step 1: AI Config', () => {
    it('should abort when no config exists for tenant', async () => {
      // Remove the cached config
      await mockKv.delete('ai_config:tenant-001');
      // D1 will return null (no results set)

      fetchSpy = vi.spyOn(globalThis, 'fetch');

      await processAIMessage(baseJob, mockEnv);

      // Should not have called AI provider
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should abort when config is inactive', async () => {
      const inactiveConfig = { ...mockAIConfig, active: 0 };
      await mockKv.put('ai_config:tenant-001', JSON.stringify(inactiveConfig));

      fetchSpy = vi.spyOn(globalThis, 'fetch');

      await processAIMessage(baseJob, mockEnv);

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Step 2: Human takeover
  // ==========================================================================

  describe('Step 2: Human Takeover', () => {
    it('should abort when human takeover is active for the contact', async () => {
      // Set human takeover flag
      await mockKv.put('human_takeover:tenant-001:contact-001', '1');

      fetchSpy = vi.spyOn(globalThis, 'fetch');

      await processAIMessage(baseJob, mockEnv);

      // Should not proceed to AI provider
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should continue when no human takeover flag is set', async () => {
      // Set up DB expectations for subsequent steps
      // Step 4: token quota check (no quota configured)
      mockDb._setNextResults([]); // token_quotas query returns null
      // Step 5: conversation context
      mockDb._setNextResults([]); // messages query returns empty
      // Step 6: KB search (entries query)
      mockDb._setNextResults([]); // no KB entries

      // Mock the AI provider response (return fresh Response each call)
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Halo! Ada yang bisa saya bantu?' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
          }),
          { status: 200 }
        );
      });

      await processAIMessage(baseJob, mockEnv);

      // Should have called fetch (AI provider)
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Step 3: Message type
  // ==========================================================================

  describe('Step 3: Message Type', () => {
    it('should abort when message type is not text', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch');

      const imageJob: AIProcessingJob = { ...baseJob, message_type: 'image' };
      await processAIMessage(imageJob, mockEnv);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should abort for video messages', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch');

      const videoJob: AIProcessingJob = { ...baseJob, message_type: 'video' };
      await processAIMessage(videoJob, mockEnv);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should abort for audio messages', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch');

      const audioJob: AIProcessingJob = { ...baseJob, message_type: 'audio' };
      await processAIMessage(audioJob, mockEnv);

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Step 4: Token quota
  // ==========================================================================

  describe('Step 4: Token Quota', () => {
    it('should abort when token quota is exceeded', async () => {
      // Quota config: monthly_limit = 1000
      mockDb._setNextResults([{ monthly_limit: 1000 }]);
      // Monthly usage sum: 1500 (exceeds limit)
      mockDb._setNextResults([{ total: 1500 }]);

      fetchSpy = vi.spyOn(globalThis, 'fetch');
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await processAIMessage(baseJob, mockEnv);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Token quota exceeded')
      );
      consoleSpy.mockRestore();
    });

    it('should continue when no quota is configured (unlimited)', async () => {
      // No quota configured (returns null)
      mockDb._setNextResults([]);
      // Conversation context
      mockDb._setNextResults([]);
      // KB search entries
      mockDb._setNextResults([]);

      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Baik!' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
          }),
          { status: 200 }
        );
      });

      await processAIMessage(baseJob, mockEnv);

      expect(fetchSpy).toHaveBeenCalled();
    });

    it('should use cached KV token count when available', async () => {
      // Set cached monthly usage in KV (exceeds quota)
      const now = new Date();
      const monthKey = `token_usage:tenant-001:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      await mockKv.put(monthKey, '5000');

      // Quota config: monthly_limit = 4000
      mockDb._setNextResults([{ monthly_limit: 4000 }]);

      fetchSpy = vi.spyOn(globalThis, 'fetch');
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await processAIMessage(baseJob, mockEnv);

      // Should abort due to cached KV count exceeding limit
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Step 8: AI Provider errors
  // ==========================================================================

  describe('Step 8: AI Provider Errors', () => {
    it('should abort and log admin alert on AI provider HTTP error', async () => {
      // Step 4: no quota
      mockDb._setNextResults([]);
      // Step 5: conversation context
      mockDb._setNextResults([]);
      // Step 6: KB search
      mockDb._setNextResults([]);

      // AI provider returns 500 (return fresh Response for each call)
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' });
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await processAIMessage(baseJob, mockEnv);

      // Should have logged the error
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('AI provider error'),
        expect.any(String)
      );

      // Should have inserted admin_alert
      const alertQuery = mockDb._queries.find(q => q.sql.includes('admin_alerts'));
      expect(alertQuery).toBeDefined();

      consoleSpy.mockRestore();
    });

    it('should abort and log admin alert on AI provider timeout', async () => {
      // Step 4: no quota
      mockDb._setNextResults([]);
      // Step 5: conversation context
      mockDb._setNextResults([]);
      // Step 6: KB search
      mockDb._setNextResults([]);

      // AI provider times out (AbortError)
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await processAIMessage(baseJob, mockEnv);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('AI provider error'),
        expect.stringContaining('timeout')
      );
      consoleSpy.mockRestore();
    });

    it('should abort on AI provider network error', async () => {
      // Step 4: no quota
      mockDb._setNextResults([]);
      // Step 5: conversation context
      mockDb._setNextResults([]);
      // Step 6: KB search
      mockDb._setNextResults([]);

      // Network error
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new Error('Network unreachable')
      );
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await processAIMessage(baseJob, mockEnv);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('AI provider error'),
        expect.any(String)
      );
      consoleSpy.mockRestore();
    });
  });

  // ==========================================================================
  // Step 9: Empty response
  // ==========================================================================

  describe('Step 9: Extract Response', () => {
    it('should abort when AI returns empty content', async () => {
      // Step 4: no quota
      mockDb._setNextResults([]);
      // Step 5: conversation context
      mockDb._setNextResults([]);
      // Step 6: KB search
      mockDb._setNextResults([]);

      // AI returns empty choices - use mockImplementation to return fresh Response each call
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 50, completion_tokens: 0, total_tokens: 50 },
          }),
          { status: 200 }
        );
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await processAIMessage(baseJob, mockEnv);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Empty AI response')
      );
      consoleSpy.mockRestore();
    });
  });

  // ==========================================================================
  // Full pipeline (happy path)
  // ==========================================================================

  describe('Full pipeline (happy path)', () => {
    it('should process message through full pipeline successfully', async () => {
      // Step 4: no quota configured
      mockDb._setNextResults([]);
      // Step 5: conversation context (2 previous messages)
      mockDb._setNextResults([
        { sender: '6281234567890', content: 'Harga produk A berapa?', message_type: 'text' },
        { sender: 'system', content: 'Produk A harganya Rp 100.000', message_type: 'text' },
      ]);
      // Step 6: KB search - returns entries
      mockDb._setNextResults([
        {
          id: 'kb-001',
          tenant_id: 'tenant-001',
          title: 'Produk A',
          content: 'Produk A adalah produk unggulan kami seharga Rp 100.000',
          category: 'products',
          tags: null,
          embedding: null,
          file_r2_key: null,
          entry_type: 'product',
          source: 'manual',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      ]);

      let aiProviderCalled = false;
      let goWaCalled = false;

      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;

        if (url.includes('chat/completions')) {
          aiProviderCalled = true;
          return new Response(
            JSON.stringify({
              choices: [{
                message: { role: 'assistant', content: 'Terima kasih sudah bertanya! Produk A tersedia dengan harga Rp 100.000.' },
                finish_reason: 'stop',
              }],
              usage: { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 },
            }),
            { status: 200 }
          );
        }

        if (url.includes('gowa') || url.includes('send/message')) {
          goWaCalled = true;
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        // KB embedding call (may be called during semanticSearch)
        if (url.includes('embeddings')) {
          return new Response(
            JSON.stringify({ data: [{ embedding: Array(128).fill(0.1) }] }),
            { status: 200 }
          );
        }

        return new Response('Not Found', { status: 404 });
      });

      // GoWa message send: findContactByPhone
      mockDb._setNextResults([{ id: 'contact-001' }]);

      await processAIMessage(baseJob, mockEnv);

      // Verify AI provider was called
      expect(aiProviderCalled).toBe(true);
      // Verify GoWa was called to send reply
      expect(goWaCalled).toBe(true);
    });
  });
});
