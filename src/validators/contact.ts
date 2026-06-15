/**
 * Contact validation utilities for the Omnichannel SaaS CRM.
 * Validates E.164 phone format and required contact fields.
 *
 * Requirements: 2.1, 2.5, 2.6
 */

import type { CreateContactInput, UpdateContactInput } from '../types';

/**
 * Structured validation error indicating which field is invalid and why.
 */
export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Result of a validation operation.
 * Contains a list of all validation errors found.
 */
export interface ContactValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * E.164 phone number format regex.
 * Must start with '+' followed by 1-15 digits.
 * The first digit after '+' must be 1-9 (no leading zero in country code).
 */
const E164_REGEX = /^\+[1-9]\d{0,14}$/;

/**
 * Validates a phone number against E.164 international format.
 *
 * E.164 format: a '+' followed by 1 to 15 digits, where the first digit is 1-9.
 *
 * @param phone - The phone number string to validate
 * @returns ValidationResult with valid flag and optional error message
 */
export function validateE164(phone: string): { valid: boolean; error?: string } {
  if (!phone || typeof phone !== 'string') {
    return { valid: false, error: 'Phone number is required' };
  }

  if (!E164_REGEX.test(phone)) {
    return {
      valid: false,
      error: 'Phone number must be in E.164 format: + followed by 1-15 digits (e.g., +6281234567890)',
    };
  }

  return { valid: true };
}

/**
 * Validates input for creating a new contact.
 *
 * Rules:
 * - full_name is required and must be a non-empty string
 * - At least one of phone_number or email must be provided
 * - If phone_number is provided, it must be valid E.164 format
 *
 * @param input - The create contact input to validate
 * @returns ContactValidationResult with all validation errors
 */
export function validateCreateContact(input: CreateContactInput): ContactValidationResult {
  const errors: ValidationError[] = [];

  // Validate full_name is present and non-empty
  if (!input.full_name || typeof input.full_name !== 'string' || input.full_name.trim().length === 0) {
    errors.push({
      field: 'full_name',
      message: 'Full name is required',
    });
  }

  // Validate at least one contact method is provided
  const hasPhone = input.phone_number !== undefined && input.phone_number !== null && input.phone_number !== '';
  const hasEmail = input.email !== undefined && input.email !== null && input.email !== '';

  if (!hasPhone && !hasEmail) {
    errors.push({
      field: 'phone_number,email',
      message: 'At least one of phone_number or email is required',
    });
  }

  // Validate phone_number format if provided
  if (hasPhone) {
    const phoneResult = validateE164(input.phone_number!);
    if (!phoneResult.valid) {
      errors.push({
        field: 'phone_number',
        message: phoneResult.error!,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates input for updating an existing contact.
 *
 * Rules:
 * - If full_name is provided, it must be a non-empty string
 * - If phone_number is provided, it must be valid E.164 format
 * - All fields are optional (partial update)
 *
 * @param input - The update contact input to validate
 * @returns ContactValidationResult with all validation errors
 */
export function validateUpdateContact(input: UpdateContactInput): ContactValidationResult {
  const errors: ValidationError[] = [];

  // Validate full_name if provided
  if (input.full_name !== undefined) {
    if (typeof input.full_name !== 'string' || input.full_name.trim().length === 0) {
      errors.push({
        field: 'full_name',
        message: 'Full name cannot be empty',
      });
    }
  }

  // Validate phone_number format if provided
  if (input.phone_number !== undefined && input.phone_number !== null && input.phone_number !== '') {
    const phoneResult = validateE164(input.phone_number);
    if (!phoneResult.valid) {
      errors.push({
        field: 'phone_number',
        message: phoneResult.error!,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
