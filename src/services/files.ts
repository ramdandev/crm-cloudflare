/**
 * File Storage Service with R2 tenant-namespaced uploads.
 * All operations are scoped to a specific tenant for data isolation.
 * Files are stored in R2 at {tenant_id}/files/{file_id}/{filename}.
 *
 * Note: Cloudflare R2 in Workers doesn't natively support presigned URLs
 * in the same way S3 does. For this implementation, getFile returns the
 * file metadata with the r2_key so the route handler can serve the file
 * directly or construct a download URL via Workers.
 *
 * Requirements: 6.1, 6.2, 6.5, 6.7, 9.2
 */

import type { FileMetadata } from '../types';
import { validateFile } from '../validators/file';

/**
 * FileService provides file upload, retrieval, and deletion operations,
 * always scoped to a specific tenant for data isolation.
 */
export class FileService {
  private db: D1Database;
  private r2: R2Bucket;

  constructor(db: D1Database, r2: R2Bucket) {
    this.db = db;
    this.r2 = r2;
  }

  /**
   * Upload a file to R2 and store metadata in D1.
   * Validates the file before storing and namespaces the R2 key with tenant_id.
   *
   * @param tenantId - The tenant uploading the file
   * @param file - The file content as ArrayBuffer or ReadableStream
   * @param filename - The original filename
   * @param contentType - The MIME content type
   * @param size - The file size in bytes
   * @returns The file metadata record
   * @throws Error if validation fails
   */
  async upload(
    tenantId: string,
    file: ArrayBuffer | ReadableStream,
    filename: string,
    contentType: string,
    size: number
  ): Promise<FileMetadata> {
    // Validate file properties
    const validation = validateFile(size, filename, contentType);
    if (!validation.valid) {
      throw new Error(`File validation failed: ${validation.error}`);
    }

    // Generate unique file ID and construct R2 key
    const fileId = crypto.randomUUID();
    const r2Key = `${tenantId}/files/${fileId}/${filename}`;
    const now = new Date().toISOString();

    // Store file in R2 with content-type metadata
    await this.r2.put(r2Key, file, {
      httpMetadata: {
        contentType: contentType,
      },
      customMetadata: {
        tenant_id: tenantId,
        file_id: fileId,
        original_filename: filename,
      },
    });

    // Store metadata in D1
    await this.db
      .prepare(
        `INSERT INTO files (id, tenant_id, filename, content_type, size, r2_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(fileId, tenantId, filename, contentType, size, r2Key, now)
      .run();

    return {
      id: fileId,
      tenant_id: tenantId,
      filename,
      content_type: contentType,
      size,
      r2_key: r2Key,
      created_at: now,
    };
  }

  /**
   * Get file metadata for a file belonging to the specified tenant.
   * Returns null if the file does not exist or does not belong to the tenant.
   *
   * Since Cloudflare R2 Workers binding doesn't support presigned URLs natively,
   * this returns the file metadata including the r2_key. The route handler can
   * use the r2_key to serve the file directly via R2 get() or construct a
   * signed download URL using a custom token mechanism.
   *
   * @param tenantId - The tenant requesting the file
   * @param fileId - The file ID to look up
   * @returns File metadata or null if not found/not owned by tenant
   */
  async getFile(tenantId: string, fileId: string): Promise<FileMetadata | null> {
    const result = await this.db
      .prepare(
        `SELECT id, tenant_id, filename, content_type, size, r2_key, created_at
         FROM files
         WHERE id = ? AND tenant_id = ?`
      )
      .bind(fileId, tenantId)
      .first<FileMetadata>();

    return result ?? null;
  }

  /**
   * Delete a file from both R2 and D1.
   * Verifies tenant ownership before deletion.
   * Returns false if the file doesn't exist or doesn't belong to the tenant.
   *
   * @param tenantId - The tenant requesting deletion
   * @param fileId - The file ID to delete
   * @returns true if the file was deleted, false if not found/not owned
   */
  async deleteFile(tenantId: string, fileId: string): Promise<boolean> {
    // Verify the file exists and belongs to this tenant
    const file = await this.getFile(tenantId, fileId);
    if (!file) {
      return false;
    }

    // Delete from R2
    await this.r2.delete(file.r2_key);

    // Delete from D1
    await this.db
      .prepare('DELETE FROM files WHERE id = ? AND tenant_id = ?')
      .bind(fileId, tenantId)
      .run();

    return true;
  }
}

// ============================================================================
// Standalone function wrappers for route consumption
// These wrap the class methods for convenience in route handlers.
// ============================================================================

/**
 * Upload a file for a tenant. Validates, stores in R2, records metadata in D1.
 */
export async function uploadFile(
  db: D1Database,
  r2: R2Bucket,
  tenantId: string,
  file: ArrayBuffer | ReadableStream,
  filename: string,
  contentType: string,
  size: number
): Promise<FileMetadata> {
  const service = new FileService(db, r2);
  return service.upload(tenantId, file, filename, contentType, size);
}

/**
 * Get file metadata for a tenant-owned file.
 * Returns null if file not found or doesn't belong to the tenant (route returns 404).
 */
export async function getFile(
  db: D1Database,
  r2: R2Bucket,
  tenantId: string,
  fileId: string
): Promise<FileMetadata | null> {
  const service = new FileService(db, r2);
  return service.getFile(tenantId, fileId);
}

/**
 * Delete a file owned by the tenant from R2 and D1.
 * Returns true if deleted, false if not found or not owned by tenant.
 */
export async function deleteFile(
  db: D1Database,
  r2: R2Bucket,
  tenantId: string,
  fileId: string
): Promise<boolean> {
  const service = new FileService(db, r2);
  return service.deleteFile(tenantId, fileId);
}
