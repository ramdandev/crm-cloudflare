/**
 * Knowledge Base Service for AI Sales Agent.
 * Handles CRUD operations for knowledge base entries, embedding generation,
 * semantic search using cosine similarity, and bulk import.
 *
 * Embeddings are stored as base64-encoded float32 vectors in D1.
 * Semantic search computes cosine similarity in-Worker for tenants with < 10K entries.
 * Falls back to text-based LIKE search when embeddings are unavailable.
 *
 * Requirements: 2.1, 2.2, 2.4, 2.5, 2.6
 */

import type { KnowledgeBaseEntry, PaginatedResult } from '../../types';

/** Maximum entries per page for list queries */
const MAX_PAGE_SIZE = 50;

/** Default page size if not specified */
const DEFAULT_PAGE_SIZE = 20;

/** Input for creating a knowledge base entry */
export interface CreateKBEntryInput {
  title: string;
  content: string;
  category: string;
  tags?: string[];
  entry_type?: 'faq' | 'product' | 'policy' | 'learned';
  source?: 'manual' | 'escalation' | 'bulk_import';
  file_r2_key?: string;
}

/** Input for updating a knowledge base entry */
export interface UpdateKBEntryInput {
  title?: string;
  content?: string;
  category?: string;
  tags?: string[];
  entry_type?: 'faq' | 'product' | 'policy' | 'learned';
  file_r2_key?: string;
}

/** Filters for listing knowledge base entries */
export interface KBListFilters {
  category?: string;
  entry_type?: 'faq' | 'product' | 'policy' | 'learned';
  page?: number;
  pageSize?: number;
}

/** Result of a bulk import operation */
export interface BulkImportResult {
  imported: number;
  errors: Array<{ index: number; error: string }>;
}

/**
 * KnowledgeBaseService provides CRUD operations for knowledge base entries,
 * embedding generation via AI providers, and semantic search.
 * All operations are scoped to a specific tenant for data isolation.
 */
export class KnowledgeBaseService {
  private db: D1Database;
  private r2: R2Bucket;

  constructor(db: D1Database, r2: R2Bucket) {
    this.db = db;
    this.r2 = r2;
  }

  /**
   * Create a new knowledge base entry.
   * Generates an embedding vector if an AI provider is configured.
   *
   * @param tenantId - The tenant creating the entry
   * @param entry - The entry creation input
   * @param providerUrl - Optional AI provider URL for embedding generation
   * @param apiKey - Optional API key for the AI provider
   * @param model - Optional embedding model name
   * @returns The created knowledge base entry
   */
  async createEntry(
    tenantId: string,
    entry: CreateKBEntryInput,
    providerUrl?: string,
    apiKey?: string,
    model?: string
  ): Promise<KnowledgeBaseEntry> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Generate embedding if provider is configured
    let embedding: string | null = null;
    if (providerUrl && apiKey) {
      embedding = await this.generateEmbedding(
        `${entry.title} ${entry.content}`,
        providerUrl,
        apiKey,
        model || 'text-embedding-3-small'
      );
    }

    const tagsJson = entry.tags ? JSON.stringify(entry.tags) : null;
    const entryType = entry.entry_type || 'faq';
    const source = entry.source || 'manual';

    await this.db
      .prepare(
        `INSERT INTO knowledge_base (id, tenant_id, title, content, category, tags, embedding, file_r2_key, entry_type, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        tenantId,
        entry.title,
        entry.content,
        entry.category,
        tagsJson,
        embedding,
        entry.file_r2_key || null,
        entryType,
        source,
        now,
        now
      )
      .run();

    return {
      id,
      tenant_id: tenantId,
      title: entry.title,
      content: entry.content,
      category: entry.category,
      tags: tagsJson,
      embedding,
      file_r2_key: entry.file_r2_key || null,
      entry_type: entryType,
      source,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Update an existing knowledge base entry.
   * Regenerates embedding if content or title changed.
   *
   * @param tenantId - The tenant updating the entry
   * @param id - The entry ID to update
   * @param updates - The fields to update
   * @param providerUrl - Optional AI provider URL for embedding regeneration
   * @param apiKey - Optional API key for the AI provider
   * @param model - Optional embedding model name
   * @returns The updated entry
   * @throws Error if entry not found
   */
  async updateEntry(
    tenantId: string,
    id: string,
    updates: UpdateKBEntryInput,
    providerUrl?: string,
    apiKey?: string,
    model?: string
  ): Promise<KnowledgeBaseEntry> {
    // Fetch existing entry
    const existing = await this.getById(tenantId, id);
    if (!existing) {
      throw new Error('Knowledge base entry not found');
    }

    const now = new Date().toISOString();
    const setClauses: string[] = [];
    const values: (string | null)[] = [];

    if (updates.title !== undefined) {
      setClauses.push('title = ?');
      values.push(updates.title);
    }

    if (updates.content !== undefined) {
      setClauses.push('content = ?');
      values.push(updates.content);
    }

    if (updates.category !== undefined) {
      setClauses.push('category = ?');
      values.push(updates.category);
    }

    if (updates.tags !== undefined) {
      setClauses.push('tags = ?');
      values.push(JSON.stringify(updates.tags));
    }

    if (updates.entry_type !== undefined) {
      setClauses.push('entry_type = ?');
      values.push(updates.entry_type);
    }

    if (updates.file_r2_key !== undefined) {
      setClauses.push('file_r2_key = ?');
      values.push(updates.file_r2_key);
    }

    // Regenerate embedding if title or content changed
    const contentChanged = updates.title !== undefined || updates.content !== undefined;
    if (contentChanged && providerUrl && apiKey) {
      const newTitle = updates.title !== undefined ? updates.title : existing.title;
      const newContent = updates.content !== undefined ? updates.content : existing.content;
      const embedding = await this.generateEmbedding(
        `${newTitle} ${newContent}`,
        providerUrl,
        apiKey,
        model || 'text-embedding-3-small'
      );
      setClauses.push('embedding = ?');
      values.push(embedding);
    }

    // Always update timestamp
    setClauses.push('updated_at = ?');
    values.push(now);

    if (setClauses.length > 0) {
      await this.db
        .prepare(
          `UPDATE knowledge_base SET ${setClauses.join(', ')} WHERE id = ? AND tenant_id = ?`
        )
        .bind(...values, id, tenantId)
        .run();
    }

    // Return the merged entry
    return {
      ...existing,
      title: updates.title !== undefined ? updates.title : existing.title,
      content: updates.content !== undefined ? updates.content : existing.content,
      category: updates.category !== undefined ? updates.category : existing.category,
      tags: updates.tags !== undefined ? JSON.stringify(updates.tags) : existing.tags,
      entry_type: updates.entry_type !== undefined ? updates.entry_type : existing.entry_type,
      file_r2_key: updates.file_r2_key !== undefined ? updates.file_r2_key : existing.file_r2_key,
      updated_at: now,
    };
  }

  /**
   * Delete a knowledge base entry and its associated R2 file (if any).
   *
   * @param tenantId - The tenant deleting the entry
   * @param id - The entry ID to delete
   * @returns true if deleted, false if not found
   */
  async deleteEntry(tenantId: string, id: string): Promise<boolean> {
    // Fetch existing entry to check for R2 file
    const existing = await this.getById(tenantId, id);
    if (!existing) {
      return false;
    }

    // Delete R2 file if exists
    if (existing.file_r2_key) {
      try {
        await this.r2.delete(existing.file_r2_key);
      } catch {
        // Ignore R2 deletion errors - file may already be removed
      }
    }

    // Delete from D1
    await this.db
      .prepare('DELETE FROM knowledge_base WHERE id = ? AND tenant_id = ?')
      .bind(id, tenantId)
      .run();

    return true;
  }

  /**
   * Get a single knowledge base entry by ID, scoped to tenant.
   *
   * @param tenantId - The tenant to scope the query to
   * @param id - The entry ID to look up
   * @returns The entry or null if not found/not owned
   */
  async getById(tenantId: string, id: string): Promise<KnowledgeBaseEntry | null> {
    const result = await this.db
      .prepare(
        `SELECT id, tenant_id, title, content, category, tags, embedding, file_r2_key, entry_type, source, created_at, updated_at
         FROM knowledge_base
         WHERE id = ? AND tenant_id = ?`
      )
      .bind(id, tenantId)
      .first<KnowledgeBaseEntry>();

    return result ?? null;
  }

  /**
   * List knowledge base entries for a tenant with optional filters and pagination.
   *
   * @param tenantId - The tenant to list entries for
   * @param filters - Optional category, entry_type, and pagination params
   * @returns Paginated result with entries
   */
  async list(
    tenantId: string,
    filters?: KBListFilters
  ): Promise<PaginatedResult<KnowledgeBaseEntry>> {
    const page = Math.max(1, filters?.page ?? 1);
    const pageSize = Math.min(Math.max(1, filters?.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
    const offset = (page - 1) * pageSize;

    // Build WHERE clause with filters
    const whereClauses: string[] = ['tenant_id = ?'];
    const whereValues: string[] = [tenantId];

    if (filters?.category) {
      whereClauses.push('category = ?');
      whereValues.push(filters.category);
    }

    if (filters?.entry_type) {
      whereClauses.push('entry_type = ?');
      whereValues.push(filters.entry_type);
    }

    const whereStr = whereClauses.join(' AND ');

    // Get total count
    const countResult = await this.db
      .prepare(`SELECT COUNT(*) as total FROM knowledge_base WHERE ${whereStr}`)
      .bind(...whereValues)
      .first<{ total: number }>();

    const total = countResult?.total ?? 0;

    // Fetch page of entries
    const results = await this.db
      .prepare(
        `SELECT id, tenant_id, title, content, category, tags, embedding, file_r2_key, entry_type, source, created_at, updated_at
         FROM knowledge_base
         WHERE ${whereStr}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
      .bind(...whereValues, pageSize, offset)
      .all<KnowledgeBaseEntry>();

    const data = results.results ?? [];

    return {
      data,
      page,
      pageSize,
      total,
      hasMore: offset + data.length < total,
    };
  }

  /**
   * Generate an embedding vector from text using an AI provider.
   * Calls the OpenAI-compatible embeddings endpoint.
   * Returns base64-encoded float32 vector, or null if the provider doesn't support embeddings.
   *
   * @param text - The text to generate an embedding for
   * @param providerUrl - The AI provider base URL
   * @param apiKey - The API key for authentication
   * @param model - The embedding model name (default: text-embedding-3-small)
   * @returns Base64-encoded float32 vector, or null on failure
   */
  async generateEmbedding(
    text: string,
    providerUrl: string,
    apiKey: string,
    model: string = 'text-embedding-3-small'
  ): Promise<string | null> {
    try {
      const url = `${providerUrl.replace(/\/$/, '')}/v1/embeddings`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: text,
        }),
      });

      if (!response.ok) {
        // Provider doesn't support embeddings or error occurred
        return null;
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[] }>;
      };

      const firstResult = data.data?.[0];
      if (!firstResult || !firstResult.embedding) {
        return null;
      }

      // Convert float array to base64-encoded Float32Array
      const floatArray = new Float32Array(firstResult.embedding);
      const buffer = floatArray.buffer;
      const bytes = new Uint8Array(buffer);

      // Convert to base64
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]!);
      }
      return btoa(binary);
    } catch {
      // If provider doesn't support embeddings, return null
      return null;
    }
  }

  /**
   * Perform semantic search over tenant knowledge base entries.
   * Generates an embedding for the query text, then computes cosine similarity
   * against all tenant entries with embeddings. Falls back to text LIKE search
   * if no embeddings exist.
   *
   * @param tenantId - The tenant to search within
   * @param queryText - The search query text
   * @param topK - Number of top results to return (default: 5)
   * @param providerUrl - Optional AI provider URL for query embedding
   * @param apiKey - Optional API key for the AI provider
   * @param model - Optional embedding model name
   * @returns Top-K entries ordered by relevance
   */
  async semanticSearch(
    tenantId: string,
    queryText: string,
    topK: number = 5,
    providerUrl?: string,
    apiKey?: string,
    model?: string
  ): Promise<KnowledgeBaseEntry[]> {
    // Try to generate query embedding
    let queryEmbedding: Float32Array | null = null;
    if (providerUrl && apiKey) {
      const embeddingBase64 = await this.generateEmbedding(
        queryText,
        providerUrl,
        apiKey,
        model || 'text-embedding-3-small'
      );
      if (embeddingBase64) {
        queryEmbedding = decodeBase64ToFloat32(embeddingBase64);
      }
    }

    // Fetch all tenant entries
    const results = await this.db
      .prepare(
        `SELECT id, tenant_id, title, content, category, tags, embedding, file_r2_key, entry_type, source, created_at, updated_at
         FROM knowledge_base
         WHERE tenant_id = ?`
      )
      .bind(tenantId)
      .all<KnowledgeBaseEntry>();

    const entries = results.results ?? [];

    if (entries.length === 0) {
      return [];
    }

    // Check if any entries have embeddings
    const entriesWithEmbeddings = entries.filter((e) => e.embedding !== null);

    // If we have a query embedding and entries with embeddings, use semantic search
    if (queryEmbedding && entriesWithEmbeddings.length > 0) {
      const scored = entriesWithEmbeddings.map((entry) => {
        const entryEmbedding = decodeBase64ToFloat32(entry.embedding!);
        const similarity = cosineSimilarity(queryEmbedding!, entryEmbedding);
        return { entry, similarity };
      });

      // Sort by similarity descending
      scored.sort((a, b) => b.similarity - a.similarity);

      // Return top-K
      return scored.slice(0, topK).map((s) => s.entry);
    }

    // Fallback: simple text search using LIKE matching on title + content
    return this.textSearch(tenantId, queryText, topK);
  }

  /**
   * Fallback text search using LIKE matching on title and content.
   *
   * @param tenantId - The tenant to search within
   * @param queryText - The search query text
   * @param topK - Number of results to return
   * @returns Matching entries
   */
  private async textSearch(
    tenantId: string,
    queryText: string,
    topK: number
  ): Promise<KnowledgeBaseEntry[]> {
    const searchPattern = `%${queryText}%`;

    const results = await this.db
      .prepare(
        `SELECT id, tenant_id, title, content, category, tags, embedding, file_r2_key, entry_type, source, created_at, updated_at
         FROM knowledge_base
         WHERE tenant_id = ? AND (title LIKE ? OR content LIKE ?)
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .bind(tenantId, searchPattern, searchPattern, topK)
      .all<KnowledgeBaseEntry>();

    return results.results ?? [];
  }

  /**
   * Bulk import multiple knowledge base entries with validation.
   * Processes each entry individually, collecting successes and failures.
   *
   * @param tenantId - The tenant importing entries
   * @param entries - Array of entries to import
   * @param providerUrl - Optional AI provider URL for embedding generation
   * @param apiKey - Optional API key for the AI provider
   * @param model - Optional embedding model name
   * @returns Import result with count of imported entries and any errors
   */
  async bulkImport(
    tenantId: string,
    entries: CreateKBEntryInput[],
    providerUrl?: string,
    apiKey?: string,
    model?: string
  ): Promise<BulkImportResult> {
    const errors: Array<{ index: number; error: string }> = [];
    let imported = 0;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;

      // Validate required fields
      if (!entry.title || typeof entry.title !== 'string' || entry.title.trim() === '') {
        errors.push({ index: i, error: 'title is required and must be a non-empty string' });
        continue;
      }

      if (!entry.content || typeof entry.content !== 'string' || entry.content.trim() === '') {
        errors.push({ index: i, error: 'content is required and must be a non-empty string' });
        continue;
      }

      if (!entry.category || typeof entry.category !== 'string' || entry.category.trim() === '') {
        errors.push({ index: i, error: 'category is required and must be a non-empty string' });
        continue;
      }

      // Validate entry_type if provided
      const validEntryTypes: string[] = ['faq', 'product', 'policy', 'learned'];
      if (entry.entry_type && !validEntryTypes.includes(entry.entry_type)) {
        errors.push({ index: i, error: `entry_type must be one of: ${validEntryTypes.join(', ')}` });
        continue;
      }

      // Validate source if provided
      const validSources: string[] = ['manual', 'escalation', 'bulk_import'];
      if (entry.source && !validSources.includes(entry.source)) {
        errors.push({ index: i, error: `source must be one of: ${validSources.join(', ')}` });
        continue;
      }

      try {
        await this.createEntry(
          tenantId,
          {
            title: entry.title,
            content: entry.content,
            category: entry.category,
            tags: entry.tags,
            entry_type: entry.entry_type,
            source: entry.source || 'bulk_import',
            file_r2_key: entry.file_r2_key,
          },
          providerUrl,
          apiKey,
          model
        );
        imported++;
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        errors.push({ index: i, error: errorMessage });
      }
    }

    return { imported, errors };
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Decode a base64-encoded string to a Float32Array.
 * Used for converting stored embeddings back to numeric vectors for computation.
 *
 * @param base64 - Base64-encoded float32 vector
 * @returns Float32Array of the decoded embedding
 */
export function decodeBase64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  // Create a new ArrayBuffer and copy to ensure proper alignment
  const alignedBuffer = new ArrayBuffer(bytes.length);
  const alignedView = new Uint8Array(alignedBuffer);
  alignedView.set(bytes);
  return new Float32Array(alignedBuffer);
}

/**
 * Encode a Float32Array to a base64 string.
 * Used for storing embedding vectors in D1.
 *
 * @param floatArray - The float32 vector to encode
 * @returns Base64-encoded string
 */
export function encodeFloat32ToBase64(floatArray: Float32Array): string {
  const bytes = new Uint8Array(floatArray.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Compute cosine similarity between two vectors.
 * Formula: dot(a, b) / (||a|| * ||b||)
 *
 * @param a - First vector
 * @param b - Second vector
 * @returns Cosine similarity in range [-1, 1]
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i]!;
    const bVal = b[i]!;
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);

  if (magnitude === 0) {
    return 0;
  }

  return dotProduct / magnitude;
}

// ============================================================================
// Standalone function wrappers for route consumption
// ============================================================================

/**
 * Create a knowledge base entry for a tenant.
 */
export async function createKBEntry(
  db: D1Database,
  r2: R2Bucket,
  tenantId: string,
  entry: CreateKBEntryInput,
  providerUrl?: string,
  apiKey?: string,
  model?: string
): Promise<KnowledgeBaseEntry> {
  const service = new KnowledgeBaseService(db, r2);
  return service.createEntry(tenantId, entry, providerUrl, apiKey, model);
}

/**
 * Update a knowledge base entry.
 */
export async function updateKBEntry(
  db: D1Database,
  r2: R2Bucket,
  tenantId: string,
  id: string,
  updates: UpdateKBEntryInput,
  providerUrl?: string,
  apiKey?: string,
  model?: string
): Promise<KnowledgeBaseEntry | null> {
  const service = new KnowledgeBaseService(db, r2);
  try {
    return await service.updateEntry(tenantId, id, updates, providerUrl, apiKey, model);
  } catch (e: unknown) {
    if (e instanceof Error && e.message === 'Knowledge base entry not found') {
      return null;
    }
    throw e;
  }
}

/**
 * Delete a knowledge base entry and its R2 file.
 */
export async function deleteKBEntry(
  db: D1Database,
  r2: R2Bucket,
  tenantId: string,
  id: string
): Promise<boolean> {
  const service = new KnowledgeBaseService(db, r2);
  return service.deleteEntry(tenantId, id);
}

/**
 * Get a knowledge base entry by ID.
 */
export async function getKBEntryById(
  db: D1Database,
  r2: R2Bucket,
  tenantId: string,
  id: string
): Promise<KnowledgeBaseEntry | null> {
  const service = new KnowledgeBaseService(db, r2);
  return service.getById(tenantId, id);
}

/**
 * List knowledge base entries with filters.
 */
export async function listKBEntries(
  db: D1Database,
  r2: R2Bucket,
  tenantId: string,
  filters?: KBListFilters
): Promise<PaginatedResult<KnowledgeBaseEntry>> {
  const service = new KnowledgeBaseService(db, r2);
  return service.list(tenantId, filters);
}

/**
 * Perform semantic search over the knowledge base.
 */
export async function searchKnowledgeBase(
  db: D1Database,
  r2: R2Bucket,
  tenantId: string,
  queryText: string,
  topK?: number,
  providerUrl?: string,
  apiKey?: string,
  model?: string
): Promise<KnowledgeBaseEntry[]> {
  const service = new KnowledgeBaseService(db, r2);
  return service.semanticSearch(tenantId, queryText, topK, providerUrl, apiKey, model);
}

/**
 * Bulk import knowledge base entries.
 */
export async function bulkImportKBEntries(
  db: D1Database,
  r2: R2Bucket,
  tenantId: string,
  entries: CreateKBEntryInput[],
  providerUrl?: string,
  apiKey?: string,
  model?: string
): Promise<BulkImportResult> {
  const service = new KnowledgeBaseService(db, r2);
  return service.bulkImport(tenantId, entries, providerUrl, apiKey, model);
}
