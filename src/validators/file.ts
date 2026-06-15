/**
 * File validation utilities for the Omnichannel SaaS CRM.
 * Validates file size, filename length, and content type against allowed formats.
 *
 * Requirements: 6.3, 6.4, 6.6
 */

import type { ValidationResult } from '../types';

/**
 * Maximum allowed file size: 16 MB in bytes.
 */
export const MAX_FILE_SIZE = 16 * 1024 * 1024; // 16 MB

/**
 * Maximum allowed filename length in characters.
 */
export const MAX_FILENAME_LENGTH = 255;

/**
 * List of allowed content types for file uploads.
 * Includes image, video, audio, PDF, and document formats.
 */
export const ALLOWED_CONTENT_TYPES = [
  // Image formats
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  // Video formats
  'video/mp4',
  'video/quicktime',
  // Audio formats
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  // PDF
  'application/pdf',
  // Microsoft Word
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // Microsoft Excel
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

/**
 * Validates a file size is within the allowed range (1 byte to 16 MB).
 *
 * @param size - File size in bytes
 * @returns ValidationResult with valid flag and optional error message
 */
export function validateFileSize(size: number): ValidationResult {
  if (size < 1) {
    return {
      valid: false,
      error: 'File size must be at least 1 byte',
    };
  }

  if (size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `File size must not exceed ${MAX_FILE_SIZE} bytes (16 MB)`,
    };
  }

  return { valid: true };
}

/**
 * Validates a filename does not exceed the maximum length and is non-empty.
 *
 * @param filename - The filename to validate
 * @returns ValidationResult with valid flag and optional error message
 */
export function validateFilename(filename: string): ValidationResult {
  if (!filename || filename.length === 0) {
    return {
      valid: false,
      error: 'Filename is required',
    };
  }

  if (filename.length > MAX_FILENAME_LENGTH) {
    return {
      valid: false,
      error: `Filename must not exceed ${MAX_FILENAME_LENGTH} characters`,
    };
  }

  return { valid: true };
}

/**
 * Validates that a content type is in the allowed list.
 *
 * @param contentType - The MIME content type to validate
 * @returns ValidationResult with valid flag and optional error message
 */
export function validateContentType(contentType: string): ValidationResult {
  if (!contentType || contentType.length === 0) {
    return {
      valid: false,
      error: 'Content type is required',
    };
  }

  if (!(ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    return {
      valid: false,
      error: `Content type '${contentType}' is not allowed. Accepted formats: image (jpeg, png, gif, webp), video (mp4, quicktime), audio (mpeg, ogg, wav), PDF, and document formats (Word, Excel)`,
    };
  }

  return { valid: true };
}

/**
 * Validates all file properties: size, filename, and content type.
 * Returns the first validation error encountered, checking in order:
 * size → filename → content type.
 *
 * @param size - File size in bytes
 * @param filename - The filename to validate
 * @param contentType - The MIME content type to validate
 * @returns ValidationResult with valid flag and optional error for the first failure
 */
export function validateFile(
  size: number,
  filename: string,
  contentType: string
): ValidationResult {
  const sizeResult = validateFileSize(size);
  if (!sizeResult.valid) {
    return sizeResult;
  }

  const filenameResult = validateFilename(filename);
  if (!filenameResult.valid) {
    return filenameResult;
  }

  const contentTypeResult = validateContentType(contentType);
  if (!contentTypeResult.valid) {
    return contentTypeResult;
  }

  return { valid: true };
}
