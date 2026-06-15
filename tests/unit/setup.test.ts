/**
 * Smoke test to verify the Vitest + Cloudflare Workers pool setup is working correctly.
 * Validates that miniflare bindings (D1, KV, R2) are accessible in the test environment.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createMockKV, createMockR2, createMockQueue, createMockBindings, createTestApp } from '../helpers';

describe('Test Infrastructure Setup', () => {
  it('should have access to D1 binding via miniflare', () => {
    expect(env.DB).toBeDefined();
  });

  it('should have access to KV binding via miniflare', () => {
    expect(env.KV).toBeDefined();
  });

  it('should have access to R2 binding via miniflare', () => {
    expect(env.R2).toBeDefined();
  });

  it('should create a test Hono app successfully', () => {
    const app = createTestApp();
    expect(app).toBeDefined();
  });
});

describe('Mock Factories', () => {
  it('should create a mock KV that supports get/put/delete', async () => {
    const kv = createMockKV();
    await kv.put('test-key', 'test-value');
    const value = await kv.get('test-key');
    expect(value).toBe('test-value');

    await kv.delete('test-key');
    const deleted = await kv.get('test-key');
    expect(deleted).toBeNull();
  });

  it('should create a mock KV that respects TTL expiration', async () => {
    const kv = createMockKV();
    // Set with a TTL that has already expired (past expiration)
    await kv.put('expired-key', 'value', { expiration: Math.floor(Date.now() / 1000) - 100 });
    const value = await kv.get('expired-key');
    expect(value).toBeNull();
  });

  it('should create a mock R2 that supports put/get/delete', async () => {
    const r2 = createMockR2();
    await r2.put('test-file.txt', 'hello world');
    const obj = await r2.get('test-file.txt');
    expect(obj).not.toBeNull();

    const text = await obj!.text();
    expect(text).toBe('hello world');

    await r2.delete('test-file.txt');
    const deleted = await r2.get('test-file.txt');
    expect(deleted).toBeNull();
  });

  it('should create a mock Queue that tracks messages', async () => {
    const queue = createMockQueue();
    await queue.send({ type: 'test', data: 'hello' });
    await queue.send({ type: 'test', data: 'world' });
    expect(queue._messages).toHaveLength(2);
    expect(queue._messages[0]).toEqual({ type: 'test', data: 'hello' });
  });

  it('should create complete mock bindings with defaults', () => {
    const bindings = createMockBindings();
    expect(bindings.DB).toBeDefined();
    expect(bindings.KV).toBeDefined();
    expect(bindings.R2).toBeDefined();
    expect(bindings.BROADCAST_QUEUE).toBeDefined();
    expect(bindings.CLERK_SECRET_KEY).toBe('test-clerk-secret-key');
    expect(bindings.GOWA_BASE_URL).toBe('http://localhost:3000');
  });

  it('should allow overriding specific bindings', () => {
    const bindings = createMockBindings({
      CLERK_SECRET_KEY: 'custom-secret',
      GOWA_BASE_URL: 'http://custom:4000',
    });
    expect(bindings.CLERK_SECRET_KEY).toBe('custom-secret');
    expect(bindings.GOWA_BASE_URL).toBe('http://custom:4000');
  });
});
