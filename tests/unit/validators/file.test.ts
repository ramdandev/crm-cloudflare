/**
 * Unit tests for file validation utilities.
 * Tests file size, filename length, and content type validation.
 *
 * Requirements: 6.3, 6.4, 6.6
 */

import { describe, it, expect } from 'vitest';
import {
  validateFileSize,
  validateFilename,
  validateContentType,
  validateFile,
  MAX_FILE_SIZE,
  MAX_FILENAME_LENGTH,
  ALLOWED_CONTENT_TYPES,
} from '../../../src/validators/file';

describe('validateFileSize', () => {
  describe('valid sizes', () => {
    it('accepts minimum valid size (1 byte)', () => {
      const result = validateFileSize(1);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('accepts maximum valid size (16 MB)', () => {
      const result = validateFileSize(MAX_FILE_SIZE);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('accepts a typical file size (1 MB)', () => {
      const result = validateFileSize(1024 * 1024);
      expect(result.valid).toBe(true);
    });
  });

  describe('invalid sizes', () => {
    it('rejects zero bytes', () => {
      const result = validateFileSize(0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('at least 1 byte');
    });

    it('rejects negative size', () => {
      const result = validateFileSize(-1);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('at least 1 byte');
    });

    it('rejects size exceeding 16 MB', () => {
      const result = validateFileSize(MAX_FILE_SIZE + 1);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('16 MB');
    });
  });
});

describe('validateFilename', () => {
  describe('valid filenames', () => {
    it('accepts a normal filename', () => {
      const result = validateFilename('document.pdf');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('accepts a single character filename', () => {
      const result = validateFilename('a');
      expect(result.valid).toBe(true);
    });

    it('accepts a filename at max length (255 characters)', () => {
      const result = validateFilename('a'.repeat(MAX_FILENAME_LENGTH));
      expect(result.valid).toBe(true);
    });
  });

  describe('invalid filenames', () => {
    it('rejects empty filename', () => {
      const result = validateFilename('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('rejects filename exceeding 255 characters', () => {
      const result = validateFilename('a'.repeat(MAX_FILENAME_LENGTH + 1));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('255');
    });
  });
});

describe('validateContentType', () => {
  describe('valid content types', () => {
    it('accepts image/jpeg', () => {
      expect(validateContentType('image/jpeg').valid).toBe(true);
    });

    it('accepts image/png', () => {
      expect(validateContentType('image/png').valid).toBe(true);
    });

    it('accepts image/gif', () => {
      expect(validateContentType('image/gif').valid).toBe(true);
    });

    it('accepts image/webp', () => {
      expect(validateContentType('image/webp').valid).toBe(true);
    });

    it('accepts video/mp4', () => {
      expect(validateContentType('video/mp4').valid).toBe(true);
    });

    it('accepts video/quicktime', () => {
      expect(validateContentType('video/quicktime').valid).toBe(true);
    });

    it('accepts audio/mpeg', () => {
      expect(validateContentType('audio/mpeg').valid).toBe(true);
    });

    it('accepts application/pdf', () => {
      expect(validateContentType('application/pdf').valid).toBe(true);
    });

    it('accepts application/msword', () => {
      expect(validateContentType('application/msword').valid).toBe(true);
    });

    it('accepts Excel format', () => {
      expect(validateContentType('application/vnd.ms-excel').valid).toBe(true);
    });

    it('accepts all allowed content types', () => {
      for (const type of ALLOWED_CONTENT_TYPES) {
        expect(validateContentType(type).valid).toBe(true);
      }
    });
  });

  describe('invalid content types', () => {
    it('rejects empty content type', () => {
      const result = validateContentType('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('rejects text/plain', () => {
      const result = validateContentType('text/plain');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not allowed');
    });

    it('rejects application/zip', () => {
      const result = validateContentType('application/zip');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not allowed');
    });

    it('rejects application/javascript', () => {
      const result = validateContentType('application/javascript');
      expect(result.valid).toBe(false);
    });

    it('provides helpful error message listing accepted formats', () => {
      const result = validateContentType('text/html');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('image');
      expect(result.error).toContain('video');
      expect(result.error).toContain('audio');
      expect(result.error).toContain('PDF');
    });
  });
});

describe('validateFile', () => {
  describe('valid files', () => {
    it('accepts a valid file with all properties correct', () => {
      const result = validateFile(1024, 'photo.jpg', 'image/jpeg');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('accepts a file at boundary sizes', () => {
      const result = validateFile(1, 'a', 'application/pdf');
      expect(result.valid).toBe(true);
    });

    it('accepts a file at maximum limits', () => {
      const result = validateFile(
        MAX_FILE_SIZE,
        'a'.repeat(MAX_FILENAME_LENGTH),
        'video/mp4'
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('returns first error encountered', () => {
    it('returns size error first when size is invalid', () => {
      const result = validateFile(0, '', 'text/plain');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('at least 1 byte');
    });

    it('returns filename error when size is valid but filename is invalid', () => {
      const result = validateFile(1024, '', 'image/jpeg');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Filename');
    });

    it('returns content type error when size and filename are valid but type is invalid', () => {
      const result = validateFile(1024, 'file.txt', 'text/plain');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not allowed');
    });
  });
});
