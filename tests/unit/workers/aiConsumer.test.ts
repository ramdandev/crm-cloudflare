/**
 * Unit tests for the AI Queue Consumer.
 * Tests sequential processing, retry logic with exponential backoff,
 * and dead-letter handling for failed messages.
 *
 * Requirements: 3.1
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAIQueue, calculateBackoff } from '../../../src/workers/aiConsumer';
import { createMockBindings } from '../../helpers';
import type { AIProcessingJob } from '../../../src/types/ai';
import type { Bindings } from '../../../src/types/bindings';

// Mock the pipeline service
vi.mock('../../../src/services/ai/pipeline', () => ({
  processAIMessage: vi.fn(),
}));

import { processAIMessage } from '../../../src/services/ai/pipeline';
const mockProcessAIMessage = vi.mocked(processAIMessage);

// ============================================================================
// Helper Factories
// ============================================================================

function createAIProcessingJob(overrides?: Partial<AIProcessingJob>): AIProcessingJob {
  return {
    tenant_id: 'tenant-001',
    contact_id: 'contact-001',
    message_id: 'msg-001',
    sender_phone: '+6281234567890',
    message_content: 'Halo, saya ingin tanya tentang produk',
    message_type: 'text',
    ...overrides,
  };
}

interface MockMessage<T> {
  body: T;
  attempts: number;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

function createMockMsg(payload: AIProcessingJob, attempts = 0): MockMessage<AIProcessingJob> {
  return {
    body: payload,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function createMockBatch(messages: MockMessage<AIProcessingJob>[]): MessageBatch<AIProcessingJob> {
  return {
    messages: messages as unknown as Message<AIProcessingJob>[],
    queue: 'ai-processing',
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<AIProcessingJob>;
}

// ============================================================================
// Unit Tests: calculateBackoff
// ============================================================================

describe('calculateBackoff', () => {
  it('should return 1 second for retryCount 0', () => {
    expect(calculateBackoff(0)).toBe(1); // Math.pow(2, 0) = 1
  });

  it('should return 2 seconds for retryCount 1', () => {
    expect(calculateBackoff(1)).toBe(2); // Math.pow(2, 1) = 2
  });

  it('should return 4 seconds for retryCount 2', () => {
    expect(calculateBackoff(2)).toBe(4); // Math.pow(2, 2) = 4
  });

  it('should return 8 seconds for retryCount 3', () => {
    expect(calculateBackoff(3)).toBe(8); // Math.pow(2, 3) = 8
  });

  it('should cap at 60 seconds maximum', () => {
    expect(calculateBackoff(6)).toBe(60); // Math.pow(2, 6) = 64, capped at 60
    expect(calculateBackoff(10)).toBe(60); // Math.pow(2, 10) = 1024, capped at 60
  });
});

// ============================================================================
// Unit Tests: handleAIQueue
// ============================================================================

describe('handleAIQueue', () => {
  let env: Bindings;

  beforeEach(() => {
    env = createMockBindings();
    vi.clearAllMocks();
  });

  it('should call processAIMessage and ack on success', async () => {
    mockProcessAIMessage.mockResolvedValueOnce(undefined);

    const payload = createAIProcessingJob();
    const msg = createMockMsg(payload);
    const batch = createMockBatch([msg]);

    await handleAIQueue(batch, env);

    expect(mockProcessAIMessage).toHaveBeenCalledTimes(1);
    expect(mockProcessAIMessage).toHaveBeenCalledWith(payload, env);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('should retry with exponential backoff on error when retries < 3', async () => {
    mockProcessAIMessage.mockRejectedValueOnce(new Error('AI provider timeout'));

    const payload = createAIProcessingJob();
    const msg = createMockMsg(payload, 1); // 1 attempt so far
    const batch = createMockBatch([msg]);

    await handleAIQueue(batch, env);

    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 2 }); // Math.pow(2, 1) = 2
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('should retry with backoff for first failure (attempts=0)', async () => {
    mockProcessAIMessage.mockRejectedValueOnce(new Error('Network error'));

    const payload = createAIProcessingJob();
    const msg = createMockMsg(payload, 0); // 0 attempts
    const batch = createMockBatch([msg]);

    await handleAIQueue(batch, env);

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 1 }); // Math.pow(2, 0) = 1
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('should retry with backoff for second failure (attempts=2)', async () => {
    mockProcessAIMessage.mockRejectedValueOnce(new Error('Rate limited'));

    const payload = createAIProcessingJob();
    const msg = createMockMsg(payload, 2); // 2 attempts
    const batch = createMockBatch([msg]);

    await handleAIQueue(batch, env);

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 4 }); // Math.pow(2, 2) = 4
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('should dead-letter (ack) when retries >= 3', async () => {
    mockProcessAIMessage.mockRejectedValueOnce(new Error('Persistent failure'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const payload = createAIProcessingJob();
    const msg = createMockMsg(payload, 3); // 3 attempts - exceeds max
    const batch = createMockBatch([msg]);

    await handleAIQueue(batch, env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('should dead-letter when retries exceed max (attempts=5)', async () => {
    mockProcessAIMessage.mockRejectedValueOnce(new Error('Still failing'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const payload = createAIProcessingJob();
    const msg = createMockMsg(payload, 5); // well beyond max
    const batch = createMockBatch([msg]);

    await handleAIQueue(batch, env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('should process messages sequentially (not in parallel)', async () => {
    const callOrder: number[] = [];

    mockProcessAIMessage
      .mockImplementationOnce(async () => {
        callOrder.push(1);
        await new Promise((resolve) => setTimeout(resolve, 10));
        callOrder.push(2);
      })
      .mockImplementationOnce(async () => {
        callOrder.push(3);
      });

    const msg1 = createMockMsg(createAIProcessingJob({ message_id: 'msg-001' }));
    const msg2 = createMockMsg(createAIProcessingJob({ message_id: 'msg-002' }));
    const batch = createMockBatch([msg1, msg2]);

    await handleAIQueue(batch, env);

    // Sequential: msg1 start(1) → msg1 end(2) → msg2 start(3)
    expect(callOrder).toEqual([1, 2, 3]);
    expect(msg1.ack).toHaveBeenCalledTimes(1);
    expect(msg2.ack).toHaveBeenCalledTimes(1);
  });

  it('should handle mixed success and failure in a batch', async () => {
    mockProcessAIMessage
      .mockResolvedValueOnce(undefined) // msg1 succeeds
      .mockRejectedValueOnce(new Error('Provider error')) // msg2 fails
      .mockResolvedValueOnce(undefined); // msg3 succeeds

    const msg1 = createMockMsg(createAIProcessingJob({ message_id: 'msg-001' }));
    const msg2 = createMockMsg(createAIProcessingJob({ message_id: 'msg-002' }), 1);
    const msg3 = createMockMsg(createAIProcessingJob({ message_id: 'msg-003' }));
    const batch = createMockBatch([msg1, msg2, msg3]);

    await handleAIQueue(batch, env);

    // msg1: acked (success)
    expect(msg1.ack).toHaveBeenCalledTimes(1);
    expect(msg1.retry).not.toHaveBeenCalled();

    // msg2: retried (failure, attempts=1 < 3)
    expect(msg2.retry).toHaveBeenCalledTimes(1);
    expect(msg2.retry).toHaveBeenCalledWith({ delaySeconds: 2 });
    expect(msg2.ack).not.toHaveBeenCalled();

    // msg3: acked (success)
    expect(msg3.ack).toHaveBeenCalledTimes(1);
    expect(msg3.retry).not.toHaveBeenCalled();
  });

  it('should handle empty batch gracefully', async () => {
    const batch = createMockBatch([]);

    await handleAIQueue(batch, env);

    expect(mockProcessAIMessage).not.toHaveBeenCalled();
  });

  it('should log error details when dead-lettering', async () => {
    const errorMessage = 'Token quota exceeded for tenant';
    mockProcessAIMessage.mockRejectedValueOnce(new Error(errorMessage));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const payload = createAIProcessingJob({
      tenant_id: 'tenant-xyz',
      contact_id: 'contact-abc',
      message_id: 'msg-dead',
    });
    const msg = createMockMsg(payload, 3);
    const batch = createMockBatch([msg]);

    await handleAIQueue(batch, env);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('tenant=tenant-xyz'),
      expect.stringContaining(errorMessage)
    );

    consoleErrorSpy.mockRestore();
  });
});
