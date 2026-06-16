/**
 * Knowledge Base routes for AI Sales Agent.
 * Mounted at /api/ai/knowledge-base in the main app.
 *
 * Routes:
 * - POST /        — Create KB entry (admin only)
 * - GET /         — List KB entries (paginated, with category/type filters)
 * - GET /:id      — Get single entry
 * - PUT /:id      — Update entry (admin only)
 * - DELETE /:id   — Delete entry (admin only)
 * - POST /bulk    — Bulk import (admin only)
 * - GET /search   — Semantic search (query param: q)
 *
 * Requirements: 2.1, 2.2, 2.4, 2.5, 2.6, 3.4
 */

import { Hono } from 'hono';
import type { Bindings, Variables } from '../../types';
import { requirePermission } from '../../middleware/rbac';
import {
  createKBEntry,
  updateKBEntry,
  deleteKBEntry,
  getKBEntryById,
  listKBEntries,
  searchKnowledgeBase,
  bulkImportKBEntries,
} from '../../services/ai/knowledgeBase';
import { getConfig } from '../../services/ai/config';

const aiKnowledgeBaseRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * POST / — Create a new knowledge base entry.
 * Requires org:admin permission.
 */
aiKnowledgeBaseRouter.post('/', requirePermission('org:admin'), async (c) => {
  const tenantId = c.get('tenantId');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Bad Request', detail: 'Invalid JSON body' }, 400);
  }

  // Validate required fields
  if (!body.title || typeof body.title !== 'string' || (body.title as string).trim() === '') {
    return c.json({ error: 'Validation Error', detail: 'title is required', field: 'title' }, 400);
  }
  if (!body.content || typeof body.content !== 'string' || (body.content as string).trim() === '') {
    return c.json({ error: 'Validation Error', detail: 'content is required', field: 'content' }, 400);
  }
  if (!body.category || typeof body.category !== 'string' || (body.category as string).trim() === '') {
    return c.json({ error: 'Validation Error', detail: 'category is required', field: 'category' }, 400);
  }

  // Get AI config for embeddings
  const config = await getConfig(c.env.DB, c.env.KV, tenantId);
  const providerUrl = config?.provider_url;
  const apiKey = config?.api_key_encrypted;

  const entry = await createKBEntry(
    c.env.DB,
    c.env.R2,
    tenantId,
    {
      title: (body.title as string).trim(),
      content: (body.content as string).trim(),
      category: (body.category as string).trim(),
      tags: Array.isArray(body.tags) ? body.tags : undefined,
      entry_type: body.entry_type as 'faq' | 'product' | 'policy' | 'learned' | undefined,
      source: body.source as 'manual' | 'escalation' | 'bulk_import' | undefined,
      file_r2_key: typeof body.file_r2_key === 'string' ? body.file_r2_key : undefined,
    },
    providerUrl,
    apiKey
  );

  return c.json(entry, 201);
});

/**
 * GET / — List knowledge base entries with pagination and filters.
 */
aiKnowledgeBaseRouter.get('/', async (c) => {
  const tenantId = c.get('tenantId');
  const category = c.req.query('category');
  const entryType = c.req.query('type');
  const page = parseInt(c.req.query('page') || '1', 10);
  const pageSize = parseInt(c.req.query('pageSize') || '20', 10);

  const result = await listKBEntries(c.env.DB, c.env.R2, tenantId, {
    category: category || undefined,
    entry_type: entryType as 'faq' | 'product' | 'policy' | 'learned' | undefined,
    page,
    pageSize,
  });

  return c.json(result, 200);
});

/**
 * GET /search — Semantic search over knowledge base entries.
 * Query parameter: q (required)
 */
aiKnowledgeBaseRouter.get('/search', async (c) => {
  const tenantId = c.get('tenantId');
  const query = c.req.query('q');

  if (!query || query.trim() === '') {
    return c.json({ error: 'Bad Request', detail: 'Query parameter "q" is required' }, 400);
  }

  const topK = parseInt(c.req.query('limit') || '5', 10);

  // Get AI config for embeddings
  const config = await getConfig(c.env.DB, c.env.KV, tenantId);
  const providerUrl = config?.provider_url;
  const apiKey = config?.api_key_encrypted;

  const results = await searchKnowledgeBase(
    c.env.DB,
    c.env.R2,
    tenantId,
    query.trim(),
    topK,
    providerUrl,
    apiKey
  );

  return c.json({ results }, 200);
});

/**
 * GET /:id — Get a single knowledge base entry by ID.
 */
aiKnowledgeBaseRouter.get('/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');

  const entry = await getKBEntryById(c.env.DB, c.env.R2, tenantId, id);

  if (!entry) {
    return c.json({ error: 'Not Found', detail: 'Knowledge base entry not found' }, 404);
  }

  return c.json(entry, 200);
});

/**
 * PUT /:id — Update a knowledge base entry.
 * Requires org:admin permission.
 */
aiKnowledgeBaseRouter.put('/:id', requirePermission('org:admin'), async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Bad Request', detail: 'Invalid JSON body' }, 400);
  }

  // Get AI config for embeddings
  const config = await getConfig(c.env.DB, c.env.KV, tenantId);
  const providerUrl = config?.provider_url;
  const apiKey = config?.api_key_encrypted;

  const updated = await updateKBEntry(
    c.env.DB,
    c.env.R2,
    tenantId,
    id,
    {
      title: typeof body.title === 'string' ? body.title.trim() : undefined,
      content: typeof body.content === 'string' ? body.content.trim() : undefined,
      category: typeof body.category === 'string' ? body.category.trim() : undefined,
      tags: Array.isArray(body.tags) ? body.tags : undefined,
      entry_type: body.entry_type as 'faq' | 'product' | 'policy' | 'learned' | undefined,
      file_r2_key: typeof body.file_r2_key === 'string' ? body.file_r2_key : undefined,
    },
    providerUrl,
    apiKey
  );

  if (!updated) {
    return c.json({ error: 'Not Found', detail: 'Knowledge base entry not found' }, 404);
  }

  return c.json(updated, 200);
});

/**
 * DELETE /:id — Delete a knowledge base entry.
 * Requires org:admin permission.
 */
aiKnowledgeBaseRouter.delete('/:id', requirePermission('org:admin'), async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');

  const deleted = await deleteKBEntry(c.env.DB, c.env.R2, tenantId, id);

  if (!deleted) {
    return c.json({ error: 'Not Found', detail: 'Knowledge base entry not found' }, 404);
  }

  return c.json({ success: true }, 200);
});

/**
 * POST /bulk — Bulk import knowledge base entries.
 * Requires org:admin permission.
 * Body: { entries: CreateKBEntryInput[] }
 */
aiKnowledgeBaseRouter.post('/bulk', requirePermission('org:admin'), async (c) => {
  const tenantId = c.get('tenantId');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Bad Request', detail: 'Invalid JSON body' }, 400);
  }

  if (!Array.isArray(body.entries)) {
    return c.json({ error: 'Validation Error', detail: 'entries must be an array', field: 'entries' }, 400);
  }

  // Get AI config for embeddings
  const config = await getConfig(c.env.DB, c.env.KV, tenantId);
  const providerUrl = config?.provider_url;
  const apiKey = config?.api_key_encrypted;

  const result = await bulkImportKBEntries(
    c.env.DB,
    c.env.R2,
    tenantId,
    body.entries,
    providerUrl,
    apiKey
  );

  return c.json(result, 200);
});

export { aiKnowledgeBaseRouter };
