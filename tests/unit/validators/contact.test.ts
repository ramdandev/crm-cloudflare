/**
 * Unit tests for contact validation utilities.
 * Tests E.164 phone validation, create contact validation, and update contact validation.
 *
 * Requirements: 2.1, 2.5, 2.6
 */

import { describe, it, expect } from 'vitest';
import {
  validateE164,
  validateCreateContact,
  validateUpdateContact,
} from '../../../src/validators/contact';

describe('validateE164', () => {
  describe('valid E.164 phone numbers', () => {
    it('accepts a minimal valid number (+1 digit)', () => {
      expect(validateE164('+1').valid).toBe(true);
    });

    it('accepts a standard US number', () => {
      expect(validateE164('+14155551234').valid).toBe(true);
    });

    it('accepts an Indonesian number', () => {
      expect(validateE164('+6281234567890').valid).toBe(true);
    });

    it('accepts a maximum 15-digit number', () => {
      expect(validateE164('+123456789012345').valid).toBe(true);
    });

    it('accepts a number with country code starting at 9', () => {
      expect(validateE164('+91234567890').valid).toBe(true);
    });
  });

  describe('invalid E.164 phone numbers', () => {
    it('rejects empty string', () => {
      const result = validateE164('');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('rejects number without plus prefix', () => {
      const result = validateE164('14155551234');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('E.164');
    });

    it('rejects number with leading zero after plus', () => {
      const result = validateE164('+0123456789');
      expect(result.valid).toBe(false);
    });

    it('rejects number exceeding 15 digits', () => {
      const result = validateE164('+1234567890123456');
      expect(result.valid).toBe(false);
    });

    it('rejects plus sign alone', () => {
      const result = validateE164('+');
      expect(result.valid).toBe(false);
    });

    it('rejects number with alphabetic characters', () => {
      const result = validateE164('+123abc4567');
      expect(result.valid).toBe(false);
    });

    it('rejects number with spaces', () => {
      const result = validateE164('+1 415 555 1234');
      expect(result.valid).toBe(false);
    });

    it('rejects number with dashes', () => {
      const result = validateE164('+1-415-555-1234');
      expect(result.valid).toBe(false);
    });

    it('rejects number with parentheses', () => {
      const result = validateE164('+(415)5551234');
      expect(result.valid).toBe(false);
    });
  });
});

describe('validateCreateContact', () => {
  describe('valid inputs', () => {
    it('accepts full_name with phone_number', () => {
      const result = validateCreateContact({
        full_name: 'John Doe',
        phone_number: '+14155551234',
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts full_name with email only', () => {
      const result = validateCreateContact({
        full_name: 'Jane Doe',
        email: 'jane@example.com',
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts full_name with both phone_number and email', () => {
      const result = validateCreateContact({
        full_name: 'Bob Smith',
        phone_number: '+6281234567890',
        email: 'bob@example.com',
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts full_name with metadata', () => {
      const result = validateCreateContact({
        full_name: 'Alice Brown',
        email: 'alice@example.com',
        metadata: { company: 'Acme Inc', tier: 'gold' },
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('missing required fields', () => {
    it('rejects missing full_name', () => {
      const result = validateCreateContact({
        full_name: '',
        phone_number: '+14155551234',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'full_name')).toBe(true);
    });

    it('rejects whitespace-only full_name', () => {
      const result = validateCreateContact({
        full_name: '   ',
        phone_number: '+14155551234',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'full_name')).toBe(true);
    });

    it('rejects missing both phone_number and email', () => {
      const result = validateCreateContact({
        full_name: 'John Doe',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'phone_number,email')).toBe(true);
    });

    it('rejects empty phone_number and empty email', () => {
      const result = validateCreateContact({
        full_name: 'John Doe',
        phone_number: '',
        email: '',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'phone_number,email')).toBe(true);
    });
  });

  describe('invalid phone_number format', () => {
    it('rejects invalid phone_number with error on field', () => {
      const result = validateCreateContact({
        full_name: 'John Doe',
        phone_number: '123456',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'phone_number')).toBe(true);
    });

    it('reports multiple errors when both name and phone are invalid', () => {
      const result = validateCreateContact({
        full_name: '',
        phone_number: 'invalid',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('validateUpdateContact', () => {
  describe('valid inputs', () => {
    it('accepts empty update (no fields to change)', () => {
      const result = validateUpdateContact({});
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts valid full_name update', () => {
      const result = validateUpdateContact({
        full_name: 'Updated Name',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts valid phone_number update', () => {
      const result = validateUpdateContact({
        phone_number: '+14155559999',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts valid email update', () => {
      const result = validateUpdateContact({
        email: 'new@example.com',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts multiple valid field updates', () => {
      const result = validateUpdateContact({
        full_name: 'New Name',
        phone_number: '+6281234567890',
        email: 'new@example.com',
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects empty full_name when provided', () => {
      const result = validateUpdateContact({
        full_name: '',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'full_name')).toBe(true);
    });

    it('rejects whitespace-only full_name when provided', () => {
      const result = validateUpdateContact({
        full_name: '   ',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'full_name')).toBe(true);
    });

    it('rejects invalid phone_number when provided', () => {
      const result = validateUpdateContact({
        phone_number: '12345',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'phone_number')).toBe(true);
    });

    it('rejects phone_number with too many digits', () => {
      const result = validateUpdateContact({
        phone_number: '+1234567890123456',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'phone_number')).toBe(true);
    });
  });
});
