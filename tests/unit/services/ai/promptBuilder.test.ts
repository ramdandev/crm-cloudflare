/**
 * Unit tests for PromptBuilder service.
 */

import { describe, it, expect } from 'vitest';
import { buildPrompt, estimateTokens, type PromptBuildInput } from '../../../../src/services/ai/promptBuilder';
import type { AIAgentConfig, ChatCompletionMessage } from '../../../../src/types/ai';

function makeConfig(overrides: Partial<AIAgentConfig> = {}): AIAgentConfig {
  return {
    id: 'cfg-1',
    tenant_id: 'tenant-1',
    provider_url: 'https://api.openai.com/v1',
    model_name: 'gpt-4o-mini',
    api_key_encrypted: 'encrypted-key',
    system_prompt: 'You are a helpful AI sales agent for Toko Bagus.',
    temperature: 0.7,
    max_tokens: 1024,
    context_window: 20,
    language: 'id',
    tone: 'friendly_professional',
    confidence_threshold: 0.7,
    active: 1,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeInput(overrides: Partial<PromptBuildInput> = {}): PromptBuildInput {
  return {
    config: makeConfig(),
    recentMessages: [],
    conversationSummary: null,
    kbEntries: [],
    contactHistory: {
      purchases: [],
      appointments: [],
      tickets: [],
    },
    pipelineStage: null,
    leadScore: null,
    currentMessage: 'Halo, ada produk apa saja?',
    ...overrides,
  };
}

describe('buildPrompt', () => {
  it('should return messages array with system message, recent messages, and current message in correct order', () => {
    const input = makeInput({
      recentMessages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Halo! Ada yang bisa saya bantu?' },
      ],
    });

    const result = buildPrompt(input);

    expect(result).toHaveLength(4); // system + 2 recent + current
    expect(result[0].role).toBe('system');
    expect(result[1].role).toBe('user');
    expect(result[1].content).toBe('Hi');
    expect(result[2].role).toBe('assistant');
    expect(result[2].content).toBe('Halo! Ada yang bisa saya bantu?');
    expect(result[3].role).toBe('user');
    expect(result[3].content).toBe('Halo, ada produk apa saja?');
  });

  it('should include only system message and current message when no context is available', () => {
    const input = makeInput();

    const result = buildPrompt(input);

    expect(result).toHaveLength(2); // system + current
    expect(result[0].role).toBe('system');
    expect(result[0].content).toBe('You are a helpful AI sales agent for Toko Bagus.');
    expect(result[1].role).toBe('user');
    expect(result[1].content).toBe('Halo, ada produk apa saja?');
  });

  it('should append conversation summary to system message when available', () => {
    const input = makeInput({
      conversationSummary: 'Customer asked about shoe prices and wants size 42.',
    });

    const result = buildPrompt(input);
    const systemContent = result[0].content;

    expect(systemContent).toContain('You are a helpful AI sales agent for Toko Bagus.');
    expect(systemContent).toContain('Previous conversation summary: Customer asked about shoe prices and wants size 42.');
  });

  it('should append formatted contact history when purchases exist', () => {
    const input = makeInput({
      contactHistory: {
        purchases: [
          { product: 'Sepatu Running X', date: '2024-01-15', amount: 500000 },
          { product: 'Kaos Polo', date: '2024-02-01', amount: 150000 },
        ],
        appointments: [],
        tickets: [],
      },
    });

    const result = buildPrompt(input);
    const systemContent = result[0].content;

    expect(systemContent).toContain('Customer history:');
    expect(systemContent).toContain('Purchases:');
    expect(systemContent).toContain('- Sepatu Running X (2024-01-15, 500000)');
    expect(systemContent).toContain('- Kaos Polo (2024-02-01, 150000)');
  });

  it('should append formatted contact history when appointments exist', () => {
    const input = makeInput({
      contactHistory: {
        purchases: [],
        appointments: [
          { date: '2024-03-10 10:00', status: 'confirmed' },
          { date: '2024-03-05 14:00', status: 'completed' },
        ],
        tickets: [],
      },
    });

    const result = buildPrompt(input);
    const systemContent = result[0].content;

    expect(systemContent).toContain('Customer history:');
    expect(systemContent).toContain('Appointments:');
    expect(systemContent).toContain('- 2024-03-10 10:00: confirmed');
    expect(systemContent).toContain('- 2024-03-05 14:00: completed');
  });

  it('should append formatted contact history when tickets exist', () => {
    const input = makeInput({
      contactHistory: {
        purchases: [],
        appointments: [],
        tickets: [
          { type: 'technical', status: 'open', description: 'App crashes on login' },
        ],
      },
    });

    const result = buildPrompt(input);
    const systemContent = result[0].content;

    expect(systemContent).toContain('Customer history:');
    expect(systemContent).toContain('Support tickets:');
    expect(systemContent).toContain('- [technical] App crashes on login (open)');
  });

  it('should not include customer history section when all history arrays are empty', () => {
    const input = makeInput({
      contactHistory: {
        purchases: [],
        appointments: [],
        tickets: [],
      },
    });

    const result = buildPrompt(input);
    const systemContent = result[0].content;

    expect(systemContent).not.toContain('Customer history:');
  });

  it('should append KB entries to system message when available', () => {
    const input = makeInput({
      kbEntries: [
        { title: 'Return Policy', content: 'Items can be returned within 7 days.', category: 'policy' },
        { title: 'Shipping Info', content: 'Free shipping for orders above 200k.', category: 'faq' },
      ],
    });

    const result = buildPrompt(input);
    const systemContent = result[0].content;

    expect(systemContent).toContain('Relevant knowledge:');
    expect(systemContent).toContain('[policy] Return Policy: Items can be returned within 7 days.');
    expect(systemContent).toContain('[faq] Shipping Info: Free shipping for orders above 200k.');
  });

  it('should not include KB section when kbEntries is empty', () => {
    const input = makeInput({ kbEntries: [] });

    const result = buildPrompt(input);
    const systemContent = result[0].content;

    expect(systemContent).not.toContain('Relevant knowledge:');
  });

  it('should append pipeline stage to system message when available', () => {
    const input = makeInput({ pipelineStage: 'negotiation' });

    const result = buildPrompt(input);
    const systemContent = result[0].content;

    expect(systemContent).toContain('Current sales stage: negotiation');
  });

  it('should not include pipeline stage when null', () => {
    const input = makeInput({ pipelineStage: null });

    const result = buildPrompt(input);
    const systemContent = result[0].content;

    expect(systemContent).not.toContain('Current sales stage:');
  });

  it('should append lead score to system message when available', () => {
    const input = makeInput({ leadScore: 'hot' });

    const result = buildPrompt(input);
    const systemContent = result[0].content;

    expect(systemContent).toContain('Lead temperature: hot');
  });

  it('should not include lead score when null', () => {
    const input = makeInput({ leadScore: null });

    const result = buildPrompt(input);
    const systemContent = result[0].content;

    expect(systemContent).not.toContain('Lead temperature:');
  });

  it('should assemble all context sections in the correct order within system message', () => {
    const input = makeInput({
      conversationSummary: 'Customer interested in premium shoes.',
      contactHistory: {
        purchases: [{ product: 'Basic Shoe', date: '2024-01-01', amount: 300000 }],
        appointments: [],
        tickets: [],
      },
      kbEntries: [
        { title: 'Premium Shoes', content: 'High quality leather.', category: 'product' },
      ],
      pipelineStage: 'explanation',
      leadScore: 'warm',
    });

    const result = buildPrompt(input);
    const systemContent = result[0].content;

    // Verify ordering: system_prompt, then summary, then history, then KB, then pipeline, then lead
    const summaryIdx = systemContent.indexOf('Previous conversation summary:');
    const historyIdx = systemContent.indexOf('Customer history:');
    const kbIdx = systemContent.indexOf('Relevant knowledge:');
    const pipelineIdx = systemContent.indexOf('Current sales stage:');
    const leadIdx = systemContent.indexOf('Lead temperature:');

    expect(summaryIdx).toBeGreaterThan(0);
    expect(historyIdx).toBeGreaterThan(summaryIdx);
    expect(kbIdx).toBeGreaterThan(historyIdx);
    expect(pipelineIdx).toBeGreaterThan(kbIdx);
    expect(leadIdx).toBeGreaterThan(pipelineIdx);
  });

  it('should preserve message order from oldest to newest', () => {
    const input = makeInput({
      recentMessages: [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'msg4' },
      ],
    });

    const result = buildPrompt(input);

    // System + 4 recent + current = 6
    expect(result).toHaveLength(6);
    expect(result[1].content).toBe('msg1');
    expect(result[2].content).toBe('msg2');
    expect(result[3].content).toBe('msg3');
    expect(result[4].content).toBe('msg4');
    expect(result[5].content).toBe('Halo, ada produk apa saja?');
  });
});

describe('estimateTokens', () => {
  it('should return 0 for empty messages array', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('should estimate tokens using chars / 4 approximation', () => {
    const messages: ChatCompletionMessage[] = [
      { role: 'system', content: 'You are helpful.' }, // 6 + 16 = 22 chars
    ];

    const result = estimateTokens(messages);

    // (6 + 16) / 4 = 5.5 → ceil = 6
    expect(result).toBe(6);
  });

  it('should sum across multiple messages', () => {
    const messages: ChatCompletionMessage[] = [
      { role: 'system', content: 'Be helpful.' }, // 6 + 11 = 17
      { role: 'user', content: 'Hello' },          // 4 + 5 = 9
      { role: 'assistant', content: 'Hi there!' }, // 9 + 9 = 18
    ];

    const result = estimateTokens(messages);

    // Total chars = 17 + 9 + 18 = 44
    // 44 / 4 = 11
    expect(result).toBe(11);
  });

  it('should handle messages with empty content', () => {
    const messages: ChatCompletionMessage[] = [
      { role: 'system', content: '' }, // 6 + 0 = 6
    ];

    const result = estimateTokens(messages);

    // 6 / 4 = 1.5 → ceil = 2
    expect(result).toBe(2);
  });

  it('should handle long messages proportionally', () => {
    const longContent = 'a'.repeat(1000);
    const messages: ChatCompletionMessage[] = [
      { role: 'user', content: longContent }, // 4 + 1000 = 1004
    ];

    const result = estimateTokens(messages);

    // 1004 / 4 = 251
    expect(result).toBe(251);
  });
});
