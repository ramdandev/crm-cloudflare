/**
 * Unit tests for AIConfigService.
 * Validates Requirements: 1.1, 1.2, 1.4, 1.5
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockKV, createMockD1 } from '../../../helpers';
import {
  getConfig,
  upsertConfig,
  validateProvider,
  encryptApiKey,
  decryptApiKey,
  maskApiKey,
  aiConfigCacheKey,
  invalidateConfigCache,
} from '../../../../src/services/ai/config';
import type { AIAgentConfig } from '../../../../src/types/ai';

describe('AIConfigService', () => {
  let mockKv: KVNamespace;
  let mockDb: ReturnType<typeof createMockD1>;
  const encryptionKey = 'test-encryption-key-32chars-long!';

  beforeEach(() => {
    mockKv = createMockKV();
    mockDb = createMockD1();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // aiConfigCacheKey
  // ==========================================================================

  describe('aiConfigCacheKey', () => {
    it('should generate correct cache key pattern', () => {
      expect(aiConfigCacheKey('tenant-123')).toBe('ai_config:tenant-123');
      expect(aiConfigCacheKey('abc')).toBe('ai_config:abc');
    });
  });

  // ==========================================================================
  // getConfig
  // ==========================================================================

  describe('getConfig', () => {
    const mockConfig: AIAgentConfig = {
      id: 'cfg-001',
      tenant_id: 'tenant-123',
      provider_url: 'https://api.openai.com/v1',
      model_name: 'gpt-4o-mini',
      api_key_encrypted: 'encrypted-key-data',
      system_prompt: 'You are a helpful assistant.',
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

    it('should return cached config from KV on cache hit', async () => {
      await mockKv.put('ai_config:tenant-123', JSON.stringify(mockConfig));

      const result = await getConfig(mockDb as unknown as D1Database, mockKv, 'tenant-123');

      expect(result).toEqual(mockConfig);
      // Should not have queried D1
      expect(mockDb._queries).toHaveLength(0);
    });

    it('should query D1 on cache miss and cache the result', async () => {
      mockDb._setNextResults([mockConfig as unknown as Record<string, unknown>]);

      const result = await getConfig(mockDb as unknown as D1Database, mockKv, 'tenant-123');

      expect(result).toEqual(mockConfig);
      expect(mockDb._queries).toHaveLength(1);
      expect(mockDb._queries[0].sql).toContain('SELECT');
      expect(mockDb._queries[0].params).toEqual(['tenant-123']);

      // Verify it was written to cache
      const cached = await mockKv.get('ai_config:tenant-123');
      expect(cached).toBe(JSON.stringify(mockConfig));
    });

    it('should return null when config does not exist', async () => {
      mockDb._setNextResults([]);

      const result = await getConfig(mockDb as unknown as D1Database, mockKv, 'tenant-xyz');

      expect(result).toBeNull();
    });

    it('should fallback to D1 when KV throws', async () => {
      const brokenKv = {
        get: vi.fn().mockRejectedValue(new Error('KV unavailable')),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      } as unknown as KVNamespace;

      mockDb._setNextResults([mockConfig as unknown as Record<string, unknown>]);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await getConfig(mockDb as unknown as D1Database, brokenKv, 'tenant-123');

      expect(result).toEqual(mockConfig);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  // ==========================================================================
  // upsertConfig
  // ==========================================================================

  describe('upsertConfig', () => {
    it('should create a new config when none exists', async () => {
      // First query: check existing (returns null)
      mockDb._setNextResults([]);

      const result = await upsertConfig(
        mockDb as unknown as D1Database,
        mockKv,
        'tenant-new',
        {
          provider_url: 'https://api.openai.com/v1',
          model_name: 'gpt-4o-mini',
          api_key_encrypted: 'sk-test-key-12345',
          system_prompt: 'Hello there!',
        },
        encryptionKey
      );

      expect(result.tenant_id).toBe('tenant-new');
      expect(result.provider_url).toBe('https://api.openai.com/v1');
      expect(result.model_name).toBe('gpt-4o-mini');
      expect(result.system_prompt).toBe('Hello there!');
      // API key should be encrypted (not the plain value)
      expect(result.api_key_encrypted).not.toBe('sk-test-key-12345');
      expect(result.api_key_encrypted.length).toBeGreaterThan(0);
      // Should have executed SELECT + INSERT
      expect(mockDb._queries).toHaveLength(2);
    });

    it('should update existing config', async () => {
      const existing: AIAgentConfig = {
        id: 'cfg-001',
        tenant_id: 'tenant-123',
        provider_url: 'https://api.openai.com/v1',
        model_name: 'gpt-3.5-turbo',
        api_key_encrypted: 'old-encrypted-key',
        system_prompt: 'Old prompt',
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

      // First query returns existing config
      mockDb._setNextResults([existing as unknown as Record<string, unknown>]);

      const result = await upsertConfig(
        mockDb as unknown as D1Database,
        mockKv,
        'tenant-123',
        { model_name: 'gpt-4o', system_prompt: 'Updated prompt' },
        encryptionKey
      );

      expect(result.model_name).toBe('gpt-4o');
      expect(result.system_prompt).toBe('Updated prompt');
      expect(result.provider_url).toBe('https://api.openai.com/v1'); // unchanged
      expect(result.id).toBe('cfg-001'); // same ID
    });

    it('should throw error when provider_url is not HTTPS', async () => {
      await expect(
        upsertConfig(
          mockDb as unknown as D1Database,
          mockKv,
          'tenant-123',
          { provider_url: 'http://insecure.api.com/v1' },
          encryptionKey
        )
      ).rejects.toThrow('provider_url must use HTTPS protocol');
    });

    it('should invalidate KV cache after upsert', async () => {
      // Seed cache
      await mockKv.put('ai_config:tenant-123', JSON.stringify({ id: 'old' }));

      // Existing config in D1
      mockDb._setNextResults([
        {
          id: 'cfg-001',
          tenant_id: 'tenant-123',
          provider_url: 'https://api.openai.com/v1',
          model_name: 'gpt-4o-mini',
          api_key_encrypted: 'enc-key',
          system_prompt: 'prompt',
          temperature: 0.7,
          max_tokens: 1024,
          context_window: 20,
          language: 'id',
          tone: 'friendly_professional',
          confidence_threshold: 0.7,
          active: 1,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      ]);

      await upsertConfig(
        mockDb as unknown as D1Database,
        mockKv,
        'tenant-123',
        { temperature: 0.9 },
        encryptionKey
      );

      // Cache should be invalidated
      const cached = await mockKv.get('ai_config:tenant-123');
      expect(cached).toBeNull();
    });

    it('should use default values for new config when not provided', async () => {
      mockDb._setNextResults([]);

      const result = await upsertConfig(
        mockDb as unknown as D1Database,
        mockKv,
        'tenant-default',
        { provider_url: 'https://api.openai.com/v1', api_key_encrypted: 'sk-test' },
        encryptionKey
      );

      expect(result.model_name).toBe('gpt-4o-mini');
      expect(result.temperature).toBe(0.7);
      expect(result.max_tokens).toBe(1024);
      expect(result.context_window).toBe(20);
      expect(result.language).toBe('id');
      expect(result.tone).toBe('friendly_professional');
      expect(result.confidence_threshold).toBe(0.7);
      expect(result.active).toBe(1);
    });
  });

  // ==========================================================================
  // validateProvider
  // ==========================================================================

  describe('validateProvider', () => {
    it('should return true when provider responds with 200', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'Hi' } }] }), { status: 200 })
      );

      const result = await validateProvider(
        'https://api.openai.com/v1',
        'sk-test-key',
        'gpt-4o-mini'
      );

      expect(result).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test-key',
          }),
        })
      );
      fetchSpy.mockRestore();
    });

    it('should return false when provider responds with error status', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Unauthorized', { status: 401 })
      );

      const result = await validateProvider(
        'https://api.openai.com/v1',
        'invalid-key',
        'gpt-4o-mini'
      );

      expect(result).toBe(false);
      fetchSpy.mockRestore();
    });

    it('should return false when fetch throws (network error)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new Error('Network unreachable')
      );
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await validateProvider(
        'https://unreachable.example.com/v1',
        'sk-key',
        'model'
      );

      expect(result).toBe(false);
      fetchSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    it('should handle URL with trailing slash', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{}', { status: 200 })
      );

      await validateProvider('https://api.openai.com/v1/', 'sk-key', 'model');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.anything()
      );
      fetchSpy.mockRestore();
    });
  });

  // ==========================================================================
  // encryptApiKey & decryptApiKey
  // ==========================================================================

  describe('encryptApiKey / decryptApiKey', () => {
    it('should encrypt and decrypt a key successfully (round-trip)', async () => {
      const plainKey = 'sk-proj-abc123xyz789';
      const encrypted = await encryptApiKey(plainKey, encryptionKey);

      expect(encrypted).not.toBe(plainKey);
      expect(encrypted.length).toBeGreaterThan(0);

      const decrypted = await decryptApiKey(encrypted, encryptionKey);
      expect(decrypted).toBe(plainKey);
    });

    it('should produce different ciphertext each time (random IV)', async () => {
      const plainKey = 'sk-test-key';
      const encrypted1 = await encryptApiKey(plainKey, encryptionKey);
      const encrypted2 = await encryptApiKey(plainKey, encryptionKey);

      // Different IVs should produce different ciphertext
      expect(encrypted1).not.toBe(encrypted2);

      // But both should decrypt to the same value
      const decrypted1 = await decryptApiKey(encrypted1, encryptionKey);
      const decrypted2 = await decryptApiKey(encrypted2, encryptionKey);
      expect(decrypted1).toBe(plainKey);
      expect(decrypted2).toBe(plainKey);
    });

    it('should fail to decrypt with wrong encryption key', async () => {
      const plainKey = 'sk-secret-key';
      const encrypted = await encryptApiKey(plainKey, encryptionKey);

      await expect(
        decryptApiKey(encrypted, 'wrong-key-that-is-different!')
      ).rejects.toThrow();
    });

    it('should handle empty string encryption', async () => {
      const encrypted = await encryptApiKey('', encryptionKey);
      const decrypted = await decryptApiKey(encrypted, encryptionKey);
      expect(decrypted).toBe('');
    });

    it('should handle long keys', async () => {
      const longKey = 'sk-' + 'a'.repeat(200);
      const encrypted = await encryptApiKey(longKey, encryptionKey);
      const decrypted = await decryptApiKey(encrypted, encryptionKey);
      expect(decrypted).toBe(longKey);
    });
  });

  // ==========================================================================
  // maskApiKey
  // ==========================================================================

  describe('maskApiKey', () => {
    it('should mask a standard API key showing last 4 chars', () => {
      expect(maskApiKey('sk-proj-abc123xyz789')).toBe('sk-...z789');
    });

    it('should mask a short key (exactly 4 chars)', () => {
      expect(maskApiKey('abcd')).toBe('sk-...abcd');
    });

    it('should return "****" for keys shorter than 4 chars', () => {
      expect(maskApiKey('abc')).toBe('****');
      expect(maskApiKey('ab')).toBe('****');
      expect(maskApiKey('a')).toBe('****');
    });

    it('should return "****" for empty string', () => {
      expect(maskApiKey('')).toBe('****');
    });
  });

  // ==========================================================================
  // invalidateConfigCache
  // ==========================================================================

  describe('invalidateConfigCache', () => {
    it('should delete the cache key from KV', async () => {
      await mockKv.put('ai_config:tenant-123', JSON.stringify({ id: 'cfg-001' }));

      await invalidateConfigCache(mockKv, 'tenant-123');

      const cached = await mockKv.get('ai_config:tenant-123');
      expect(cached).toBeNull();
    });

    it('should not throw when key does not exist', async () => {
      await expect(invalidateConfigCache(mockKv, 'nonexistent')).resolves.not.toThrow();
    });

    it('should log error but not throw when KV delete fails', async () => {
      const brokenKv = {
        delete: vi.fn().mockRejectedValue(new Error('KV delete failed')),
      } as unknown as KVNamespace;

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(invalidateConfigCache(brokenKv, 'tenant-123')).resolves.not.toThrow();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});
