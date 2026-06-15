/**
 * Test helper utilities for the Omnichannel SaaS CRM
 * Provides mock factories for Cloudflare bindings and Hono test app creation
 */
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import type { Bindings, Variables } from '../../src/index';

// Re-export env for direct access in tests
export { env };

/**
 * Creates a fully configured test Hono app with the same type bindings as production.
 * Optionally accepts middleware and routes to mount for testing.
 */
export function createTestApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  return app;
}

/**
 * Creates a mock KV namespace with in-memory storage.
 * Useful for unit tests where you don't need miniflare bindings.
 */
export function createMockKV(): KVNamespace {
  const store = new Map<string, { value: string; expiration?: number }>();

  return {
    get: async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiration && Date.now() / 1000 > entry.expiration) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number; expiration?: number }) => {
      const expiration = options?.expiration
        ?? (options?.expirationTtl ? Math.floor(Date.now() / 1000) + options.expirationTtl : undefined);
      store.set(key, { value, expiration });
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => {
      const keys = Array.from(store.keys()).map((name) => ({
        name,
        expiration: store.get(name)?.expiration,
        metadata: undefined,
      }));
      return { keys, list_complete: true, cacheStatus: null } as unknown as KVNamespaceListResult<unknown>;
    },
    getWithMetadata: async (key: string) => {
      const value = await (this as unknown as KVNamespace).get(key);
      return { value, metadata: null, cacheStatus: null } as unknown as KVNamespaceGetWithMetadataResult<string, unknown>;
    },
  } as unknown as KVNamespace;
}

/**
 * Creates a mock D1Database for unit testing.
 * Provides a minimal interface that tracks prepared statements.
 */
export function createMockD1(): D1Database & { _queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = [];

  const createResult = (rows: Record<string, unknown>[] = []): D1Result<Record<string, unknown>> => ({
    results: rows,
    success: true,
    meta: {
      duration: 0,
      last_row_id: 0,
      changes: rows.length,
      served_by: 'mock',
      internal_stats: null,
      changed_db: false,
      size_after: 0,
      rows_read: rows.length,
      rows_written: 0,
    },
  });

  const mockDb = {
    _queries: queries,
    _mockResults: [] as Record<string, unknown>[][],

    /**
     * Set the results that the next query will return.
     */
    _setNextResults(results: Record<string, unknown>[]) {
      this._mockResults.push(results);
    },

    prepare(sql: string) {
      let boundParams: unknown[] = [];

      const statement = {
        bind(...params: unknown[]) {
          boundParams = params;
          return statement;
        },
        async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
          queries.push({ sql, params: boundParams });
          const results = mockDb._mockResults.shift() || [];
          const row = results[0] || null;
          if (column && row) {
            return (row as Record<string, unknown>)[column] as T;
          }
          return row as T | null;
        },
        async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
          queries.push({ sql, params: boundParams });
          const results = mockDb._mockResults.shift() || [];
          return createResult(results) as unknown as D1Result<T>;
        },
        async run(): Promise<D1Result<Record<string, unknown>>> {
          queries.push({ sql, params: boundParams });
          mockDb._mockResults.shift();
          return createResult();
        },
        async raw<T = unknown[]>(): Promise<T[]> {
          queries.push({ sql, params: boundParams });
          const results = mockDb._mockResults.shift() || [];
          return results.map((row) => Object.values(row)) as T[];
        },
      };

      return statement;
    },

    async dump(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    },

    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const results: D1Result<T>[] = [];
      for (const stmt of statements) {
        results.push(await (stmt as unknown as { all(): Promise<D1Result<T>> }).all());
      }
      return results;
    },

    async exec(query: string): Promise<D1ExecResult> {
      queries.push({ sql: query, params: [] });
      return { count: 0, duration: 0 };
    },
  };

  return mockDb as unknown as D1Database & { _queries: Array<{ sql: string; params: unknown[] }> };
}

/**
 * Creates a mock R2Bucket for unit testing.
 * Provides in-memory object storage simulation.
 */
export function createMockR2(): R2Bucket {
  const objects = new Map<string, { body: ArrayBuffer; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }>();

  return {
    async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob, options?: R2PutOptions) {
      let body: ArrayBuffer;
      if (value instanceof ArrayBuffer) {
        body = value;
      } else if (typeof value === 'string') {
        body = new TextEncoder().encode(value).buffer as ArrayBuffer;
      } else if (value === null) {
        body = new ArrayBuffer(0);
      } else {
        body = new ArrayBuffer(0);
      }
      objects.set(key, {
        body,
        httpMetadata: options?.httpMetadata as R2HTTPMetadata | undefined,
        customMetadata: options?.customMetadata,
      });
      return {
        key,
        version: 'mock-version',
        size: body.byteLength,
        etag: 'mock-etag',
        httpEtag: '"mock-etag"',
        uploaded: new Date(),
        httpMetadata: options?.httpMetadata || {},
        customMetadata: options?.customMetadata || {},
        checksums: { toJSON: () => ({}) },
        storageClass: 'Standard',
      } as unknown as R2Object;
    },

    async get(key: string) {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        key,
        version: 'mock-version',
        size: obj.body.byteLength,
        etag: 'mock-etag',
        httpEtag: '"mock-etag"',
        uploaded: new Date(),
        httpMetadata: obj.httpMetadata || {},
        customMetadata: obj.customMetadata || {},
        checksums: { toJSON: () => ({}) },
        storageClass: 'Standard',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(obj.body));
            controller.close();
          },
        }),
        bodyUsed: false,
        arrayBuffer: async () => obj.body,
        text: async () => new TextDecoder().decode(obj.body),
        json: async () => JSON.parse(new TextDecoder().decode(obj.body)),
        blob: async () => new Blob([obj.body]),
        writeHttpMetadata: () => {},
      } as unknown as R2ObjectBody;
    },

    async delete(keys: string | string[]) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) {
        objects.delete(key);
      }
    },

    async head(key: string) {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        key,
        version: 'mock-version',
        size: obj.body.byteLength,
        etag: 'mock-etag',
        httpEtag: '"mock-etag"',
        uploaded: new Date(),
        httpMetadata: obj.httpMetadata || {},
        customMetadata: obj.customMetadata || {},
        checksums: { toJSON: () => ({}) },
        storageClass: 'Standard',
      } as unknown as R2Object;
    },

    async list(options?: R2ListOptions) {
      const prefix = options?.prefix || '';
      const matchingKeys = Array.from(objects.keys()).filter((k) => k.startsWith(prefix));
      const objectList = matchingKeys.map((key) => ({
        key,
        version: 'mock-version',
        size: objects.get(key)!.body.byteLength,
        etag: 'mock-etag',
        httpEtag: '"mock-etag"',
        uploaded: new Date(),
        httpMetadata: {},
        customMetadata: {},
        checksums: { toJSON: () => ({}) },
        storageClass: 'Standard',
      }));
      return {
        objects: objectList,
        truncated: false,
        delimitedPrefixes: [],
      } as unknown as R2Objects;
    },

    createMultipartUpload: async () => { throw new Error('Not implemented in mock'); },
    resumeMultipartUpload: () => { throw new Error('Not implemented in mock'); },
  } as unknown as R2Bucket;
}

/**
 * Creates a mock Queue for unit testing.
 * Tracks messages sent to the queue.
 */
export function createMockQueue(): Queue & { _messages: unknown[] } {
  const messages: unknown[] = [];

  return {
    _messages: messages,
    async send(message: unknown) {
      messages.push(message);
    },
    async sendBatch(batch: Iterable<MessageSendRequest>) {
      for (const item of batch) {
        messages.push(item.body);
      }
    },
  } as unknown as Queue & { _messages: unknown[] };
}

/**
 * Creates a complete set of mock bindings for testing.
 * Returns all bindings needed by the Hono app with mock implementations.
 */
export function createMockBindings(overrides?: Partial<Bindings>): Bindings {
  return {
    DB: createMockD1() as unknown as D1Database,
    KV: createMockKV(),
    R2: createMockR2(),
    BROADCAST_QUEUE: createMockQueue() as unknown as Queue,
    CLERK_SECRET_KEY: 'test-clerk-secret-key',
    GOWA_BASE_URL: 'http://localhost:3000',
    GOWA_API_KEY: 'test-gowa-api-key',
    META_ACCESS_TOKEN: 'test-meta-access-token',
    META_PHONE_NUMBER_ID: 'test-phone-number-id',
    IPAYMU_API_KEY: 'test-ipaymu-api-key',
    IPAYMU_VA: 'test-ipaymu-va',
    IPAYMU_SECRET: 'test-ipaymu-secret',
    ...overrides,
  };
}

/**
 * Generates a mock UUID for testing purposes.
 */
export function mockUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Creates a mock tenant context with common test values.
 */
export function createMockTenantContext(overrides?: {
  tenantId?: string;
  userId?: string;
  orgId?: string;
  permissions?: string[];
}) {
  return {
    tenantId: overrides?.tenantId ?? 'test-tenant-001',
    userId: overrides?.userId ?? 'user_test123',
    orgId: overrides?.orgId ?? 'org_test456',
    permissions: overrides?.permissions ?? ['org:admin'],
  };
}

/**
 * Helper to initialize D1 schema in test environment.
 * Executes the migration SQL against the test D1 binding.
 */
export async function initTestDatabase(db: D1Database, schema: string): Promise<void> {
  // Split schema into individual statements and execute each
  const statements = schema
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));

  for (const statement of statements) {
    await db.exec(statement + ';');
  }
}
