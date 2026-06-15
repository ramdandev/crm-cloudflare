/**
 * File storage routes for the Omnichannel SaaS CRM.
 * Mounted at /api/files in the main app.
 *
 * Routes:
 * - POST /upload       - Upload a file (multipart form data)
 * - GET /:id/download  - Download a file (served directly with proper headers)
 * - DELETE /:id        - Delete a file
 *
 * Requirements: 6.1, 6.2, 6.4, 6.7
 */

import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { uploadFile, getFile, deleteFile } from '../services/files';

const filesRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * POST /upload - Upload a file
 * Expects multipart/form-data with a "file" field.
 * Returns 201 with FileMetadata on success.
 * Returns 400 if file is missing or validation fails.
 */
filesRouter.post('/upload', async (c) => {
  const tenantId = c.get('tenantId');

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json(
      { error: 'Bad Request', detail: 'Invalid multipart form data' },
      400
    );
  }

  const file = formData.get('file') as unknown as File | null;
  if (!file || typeof file === 'string') {
    return c.json(
      { error: 'Bad Request', detail: 'Missing required "file" field in form data' },
      400
    );
  }

  const filename = file.name || 'unnamed';
  const contentType = file.type || 'application/octet-stream';
  const size = file.size;

  try {
    const fileBuffer = await file.arrayBuffer();
    const metadata = await uploadFile(
      c.env.DB,
      c.env.R2,
      tenantId,
      fileBuffer,
      filename,
      contentType,
      size
    );

    return c.json(metadata, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed';
    // Check if it's a validation error from the file service
    if (message.startsWith('File validation failed:')) {
      return c.json(
        { error: 'Validation Error', detail: message.replace('File validation failed: ', '') },
        400
      );
    }
    return c.json({ error: 'Internal Error', detail: 'File upload failed' }, 500);
  }
});

/**
 * GET /:id/download - Download a file
 * Fetches the file from R2 and serves it directly with proper
 * content-type and content-disposition headers.
 * Returns 404 if the file does not exist or doesn't belong to the tenant.
 */
filesRouter.get('/:id/download', async (c) => {
  const tenantId = c.get('tenantId');
  const fileId = c.req.param('id');

  // Get file metadata (tenant-scoped)
  const metadata = await getFile(c.env.DB, c.env.R2, tenantId, fileId);
  if (!metadata) {
    return c.json({ error: 'Not Found', detail: 'File not found' }, 404);
  }

  // Fetch the file from R2
  const r2Object = await c.env.R2.get(metadata.r2_key);
  if (!r2Object) {
    return c.json({ error: 'Not Found', detail: 'File not found in storage' }, 404);
  }

  // Return the file with proper headers
  const headers = new Headers();
  headers.set('Content-Type', metadata.content_type);
  headers.set(
    'Content-Disposition',
    `attachment; filename="${metadata.filename}"`
  );
  headers.set('Content-Length', String(metadata.size));

  return new Response(r2Object.body, {
    status: 200,
    headers,
  });
});

/**
 * DELETE /:id - Delete a file
 * Removes the file from both R2 and D1.
 * Returns 204 on success, 404 if not found or not owned by tenant.
 */
filesRouter.delete('/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const fileId = c.req.param('id');

  const deleted = await deleteFile(c.env.DB, c.env.R2, tenantId, fileId);
  if (!deleted) {
    return c.json({ error: 'Not Found', detail: 'File not found' }, 404);
  }

  return c.body(null, 204);
});

export { filesRouter };
