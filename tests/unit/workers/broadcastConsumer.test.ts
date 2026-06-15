/**
 * Unit tests for the Broadcast Queue Consumer.
 * Tests Meta Cloud API integration, retry logic, and status updates.
 *
 * Requirements: 4.2, 4.3, 4.4, 4.7, 4.8
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleBroadcastQueue,
  calculateBackoff,
  buildMetaApiBody,
  isPermanentFailure,
  isRateLimitError,
} from '../../../src/workers/broadcastConsumer';
import { createMockD1, createMockBindings } from '../../helpers';
import type { QueueMessage, Bindings } from '../../../src/types';

// ============================================================================
// Helper Factories
// ============================================================================

function createQueueMessage(overrides?: Partial<QueueMessage>): QueueMessage {
  return {
    broadcast_id: 'broadcast-001',
    tenant_id: 'tenant-001',
    contact_phone: '+6281234567890',
    template_name: 'hello_world',
    template_language: 'en',
    retry_count: 0,
    max_retries: 5,
    ...overrides,
  };
}

interface MockMessage<T> {
  body: T;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

function createMockMsg(payload: QueueMessage): MockMessage<QueueMessage> {
  return {
    body: payload,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function createMockBatch(messages: MockMessage<QueueMessage>[]): MessageBatch<QueueMessage> {
  return {
    messages: messages as unknown as Message<QueueMessage>[],
    queue: 'broadcast-queue',
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<QueueMessage>;
}

// ============================================================================
// Unit Tests: calculateBackoff
// ============================================================================

describe('calculateBackoff', () => {
  it('should return 1 second for retry_count 0', () => {
    expect(calculateBackoff(0)).toBe(1); // Math.pow(2, 0) = 1
  });

  it('should return 2 seconds for retry_count 1', () => {
    expect(calculateBackoff(1)).toBe(2); // Math.pow(2, 1) = 2
  });

  it('should return 4 seconds for retry_count 2', () => {
    expect(calculateBackoff(2)).toBe(4); // Math.pow(2, 2) = 4
  });

  it('should return 8 seconds for retry_count 3', () => {
    expect(calculateBackoff(3)).toBe(8); // Math.pow(2, 3) = 8
  });

  it('should return 16 seconds for retry_count 4', () => {
    expect(calculateBackoff(4)).toBe(16); // Math.pow(2, 4) = 16
  });

  it('should cap at 300 seconds maximum', () => {
    expect(calculateBackoff(9)).toBe(300); // Math.pow(2, 9) = 512, capped at 300
    expect(calculateBackoff(10)).toBe(300); // Math.pow(2, 10) = 1024, capped at 300
    expect(calculateBackoff(20)).toBe(300); // much larger, still 300
  });
});

// ============================================================================
// Unit Tests: buildMetaApiBody
// ============================================================================

describe('buildMetaApiBody', () => {
  it('should build a basic template message body without params', () => {
    const body = buildMetaApiBody('+6281234567890', 'hello_world', 'en');

    expect(body).toEqual({
      messaging_product: 'whatsapp',
      to: '+6281234567890',
      type: 'template',
      template: {
        name: 'hello_world',
        language: { code: 'en' },
      },
    });
  });

  it('should include template parameters as components when provided', () => {
    const params = { name: 'John', order_id: '12345' };
    const body = buildMetaApiBody('+6281234567890', 'order_update', 'id', params);

    expect(body.messaging_product).toBe('whatsapp');
    expect(body.to).toBe('+6281234567890');
    expect(body.type).toBe('template');

    const template = body.template as Record<string, unknown>;
    expect(template.name).toBe('order_update');
    expect((template.language as Record<string, string>).code).toBe('id');

    const components = template.components as Array<Record<string, unknown>>;
    expect(components).toBeDefined();
    expect(components[0]!.type).toBe('body');

    const parameters = (components[0] as Record<string, unknown>).parameters as Array<Record<string, string>>;
    expect(parameters).toHaveLength(2);
    expect(parameters[0]).toEqual({ type: 'text', text: 'John' });
    expect(parameters[1]).toEqual({ type: 'text', text: '12345' });
  });

  it('should not include components when template_params is empty object', () => {
    const body = buildMetaApiBody('+6281234567890', 'hello_world', 'en', {});

    const template = body.template as Record<string, unknown>;
    expect(template.components).toBeUndefined();
  });
});

// ============================================================================
// Unit Tests: isPermanentFailure / isRateLimitError
// ============================================================================

describe('isPermanentFailure', () => {
  it('should return true for 400 Bad Request', () => {
    expect(isPermanentFailure(400)).toBe(true);
  });

  it('should return true for 401 Unauthorized', () => {
    expect(isPermanentFailure(401)).toBe(true);
  });

  it('should return true for 403 Forbidden', () => {
    expect(isPermanentFailure(403)).toBe(true);
  });

  it('should return true for 404 Not Found', () => {
    expect(isPermanentFailure(404)).toBe(true);
  });

  it('should return false for 429 Rate Limit (not permanent)', () => {
    expect(isPermanentFailure(429)).toBe(false);
  });

  it('should return false for 200 OK', () => {
    expect(isPermanentFailure(200)).toBe(false);
  });

  it('should return false for 500 Server Error', () => {
    expect(isPermanentFailure(500)).toBe(false);
  });

  it('should return false for 503 Service Unavailable', () => {
    expect(isPermanentFailure(503)).toBe(false);
  });
});

describe('isRateLimitError', () => {
  it('should return true for 429', () => {
    expect(isRateLimitError(429)).toBe(true);
  });

  it('should return false for 400', () => {
    expect(isRateLimitError(400)).toBe(false);
  });

  it('should return false for 200', () => {
    expect(isRateLimitError(200)).toBe(false);
  });

  it('should return false for 500', () => {
    expect(isRateLimitError(500)).toBe(false);
  });
});

// ============================================================================
// Unit Tests: handleBroadcastQueue
// ============================================================================

describe('handleBroadcastQueue', () => {
  let env: Bindings;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    env = createMockBindings();
    // Mock the global fetch
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('should send message to Meta Cloud API and ack on success (Req 4.3)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: 'wamid.123' }] }), { status: 200 }));

    const payload = createQueueMessage();
    const msg = createMockMsg(payload);
    const batch = createMockBatch([msg]);

    await handleBroadcastQueue(batch, env);

    // Verify fetch was called with correct Meta Cloud API URL and headers
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://graph.facebook.com/v18.0/${env.META_PHONE_NUMBER_ID}/messages`);
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe(`Bearer ${env.META_ACCESS_TOKEN}`);
    expect(options.headers['Content-Type']).toBe('application/json');

    // Verify the request body
    const body = JSON.parse(options.body);
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.to).toBe('+6281234567890');
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('hello_world');
    expect(body.template.language.code).toBe('en');

    // Should ack the message
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('should retry with exponential backoff on rate-limit 429 (Req 4.4)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Rate limited', { status: 429 }));

    const payload = createQueueMessage({ retry_count: 2 });
    const msg = createMockMsg(payload);
    const batch = createMockBatch([msg]);

    await handleBroadcastQueue(batch, env);

    // Should retry with backoff delay
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 4 }); // Math.pow(2, 2) = 4
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('should mark as failed on permanent failure 4xx (Req 4.7)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Invalid recipient', { status: 400 }));

    const payload = createQueueMessage();
    const msg = createMockMsg(payload);
    const batch = createMockBatch([msg]);

    await handleBroadcastQueue(batch, env);

    // Should ack (not retry) on permanent failure
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('should mark as failed when max retries exceeded (Req 4.8)', async () => {
    const payload = createQueueMessage({ retry_count: 5, max_retries: 5 });
    const msg = createMockMsg(payload);
    const batch = createMockBatch([msg]);

    await handleBroadcastQueue(batch, env);

    // Should ack without calling Meta API
    expect(fetchMock).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('should retry on 5xx server errors with backoff', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    const payload = createQueueMessage({ retry_count: 1 });
    const msg = createMockMsg(payload);
    const batch = createMockBatch([msg]);

    await handleBroadcastQueue(batch, env);

    // Should retry with backoff
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 2 }); // Math.pow(2, 1) = 2
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('should retry on network errors with backoff', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network timeout'));

    const payload = createQueueMessage({ retry_count: 3 });
    const msg = createMockMsg(payload);
    const batch = createMockBatch([msg]);

    await handleBroadcastQueue(batch, env);

    // Should retry with backoff
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 8 }); // Math.pow(2, 3) = 8
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('should process multiple messages in a batch sequentially (Req 4.2)', async () => {
    // First message succeeds, second gets rate-limited
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('Rate limited', { status: 429 }));

    const msg1 = createMockMsg(createQueueMessage({ contact_phone: '+6281111111111' }));
    const msg2 = createMockMsg(createQueueMessage({ contact_phone: '+6282222222222', retry_count: 1 }));
    const batch = createMockBatch([msg1, msg2]);

    await handleBroadcastQueue(batch, env);

    // First message should be acked (success)
    expect(msg1.ack).toHaveBeenCalledTimes(1);
    expect(msg1.retry).not.toHaveBeenCalled();

    // Second message should be retried (rate-limited)
    expect(msg2.retry).toHaveBeenCalledTimes(1);
    expect(msg2.retry).toHaveBeenCalledWith({ delaySeconds: 2 });
    expect(msg2.ack).not.toHaveBeenCalled();
  });

  it('should use correct backoff for first retry (retry_count=0)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Rate limited', { status: 429 }));

    const payload = createQueueMessage({ retry_count: 0 });
    const msg = createMockMsg(payload);
    const batch = createMockBatch([msg]);

    await handleBroadcastQueue(batch, env);

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 1 }); // Math.pow(2, 0) = 1
  });

  it('should handle 403 as permanent failure and not retry', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Forbidden - account blocked', { status: 403 }));

    const payload = createQueueMessage();
    const msg = createMockMsg(payload);
    const batch = createMockBatch([msg]);

    await handleBroadcastQueue(batch, env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('should include template params in Meta API request body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const payload = createQueueMessage({
      template_name: 'order_confirmation',
      template_params: { customer_name: 'Alice', order_number: 'ORD-001' },
    });
    const msg = createMockMsg(payload);
    const batch = createMockBatch([msg]);

    await handleBroadcastQueue(batch, env);

    const [, options] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(options.body);
    expect(body.template.components).toBeDefined();
    expect(body.template.components[0].type).toBe('body');
    expect(body.template.components[0].parameters).toHaveLength(2);
  });

  it('should handle empty batch gracefully', async () => {
    const batch = createMockBatch([]);

    await handleBroadcastQueue(batch, env);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
