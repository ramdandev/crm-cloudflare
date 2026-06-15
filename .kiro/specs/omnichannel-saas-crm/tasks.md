# Implementation Plan: Omnichannel SaaS CRM

## Overview

This implementation plan breaks down the Omnichannel SaaS CRM platform into incremental coding tasks. The platform runs on Cloudflare Workers with Hono (TypeScript), using D1, KV, R2, Queues, Clerk Organizations, Go-Wa, Meta Cloud API, and iPaymu. Each task builds on prior work and ends with integrated, wired-up code.

## Tasks

- [x] 1. Project setup and core infrastructure
  - [x] 1.1 Initialize Cloudflare Workers project with Hono, configure wrangler.toml bindings for D1, KV, R2, and Queues, and set up TypeScript configuration
    - Create `wrangler.toml` with all bindings (DB, KV, R2, BROADCAST_QUEUE) and environment variables
    - Set up `tsconfig.json` with strict mode and Cloudflare Workers types
    - Install dependencies: `hono`, `@clerk/backend`, `fast-check`, `vitest`, `@cloudflare/vitest-pool-workers`
    - Create `src/index.ts` main entry with Hono app, Bindings and Variables types as defined in the design
    - _Requirements: 1.1, 1.2, 7.1_

  - [x] 1.2 Create D1 SQL schema migration file with all tables, indexes, and constraints
    - Create a migration file containing the full schema: tenants, contacts, messages, message_status_log, broadcasts, broadcast_messages, transactions, files, webhook_events, admin_alerts
    - Include all CHECK constraints, FOREIGN KEY references, and indexes as defined in the design data model
    - _Requirements: 2.1, 3.5, 4.1, 5.7, 6.5, 8.1, 9.1, 10.2_

  - [x] 1.3 Define shared TypeScript types and interfaces for all services
    - Create `src/types/index.ts` with all shared interfaces: Contact, GoWaMessage, BroadcastRequest, BroadcastResult, QueueMessage, PaymentRequest, PaymentLinkResult, IPaymuWebhook, FileMetadata, ValidationResult, ErrorResponse, PaginatedResult
    - Define Bindings and Variables types in a shared location
    - _Requirements: 2.1, 3.5, 4.1, 5.1, 6.1_

  - [x] 1.4 Set up Vitest configuration with Cloudflare Workers pool and test directory structure
    - Create `vitest.config.ts` with `@cloudflare/vitest-pool-workers` pool configuration
    - Set up test directory structure: `tests/unit/`, `tests/property/`, `tests/integration/`
    - Create test helper utilities for D1 miniflare bindings and mock factories
    - _Requirements: All (testing infrastructure)_

- [x] 2. Authentication and tenant resolution middleware
  - [x] 2.1 Implement authentication middleware that verifies Clerk session tokens and extracts organization context
    - Create `src/middleware/auth.ts` using `@clerk/backend` `verifyToken`
    - Extract Bearer token from Authorization header; return 401 if missing/invalid
    - Set `userId`, `orgId`, and `permissions` variables on Hono context from token payload
    - Return 401 with no application data if token verification fails
    - _Requirements: 1.1, 1.4, 1.5_

  - [x] 2.2 Implement tenant resolution middleware with KV caching and D1 fallback
    - Create `src/middleware/tenant.ts`
    - Check KV cache (`org_tenant:{orgId}`) first; on miss query D1 `tenants` table
    - Cache resolved tenant_id with configurable TTL (default 300s)
    - Return 403 and log admin alert if org cannot be resolved
    - Set `tenantId` on Hono context
    - _Requirements: 1.2, 1.3, 1.7_

  - [x] 2.3 Implement RBAC permission checking utility
    - Create `src/middleware/rbac.ts` with a `requirePermission(permission: string)` middleware factory
    - Verify user has required permission from the Clerk token's `org_permissions` array
    - Return 403 with required permission name if check fails
    - _Requirements: 1.4, 1.6_

  - [ ]* 2.4 Write property test for Organization-to-Tenant Resolution Round Trip
    - **Property 2: Organization-to-Tenant Resolution Round Trip**
    - **Validates: Requirements 1.2, 1.3**

  - [ ]* 2.5 Write property test for Unauthenticated Request Rejection
    - **Property 12: Unauthenticated Request Rejection**
    - **Validates: Requirements 1.5**

- [x] 3. Rate limiting middleware
  - [x] 3.1 Implement rate limiting middleware using KV counters with per-tenant configurable limits
    - Create `src/middleware/rateLimit.ts`
    - Use KV key pattern `rate:{tenantId}:{window}` with 60-second windows
    - Read tenant rate limit from KV config or use default (1000 req/min)
    - Return 429 with `Retry-After` header when limit exceeded
    - Gracefully bypass if KV is unreachable (log and continue to D1)
    - _Requirements: 7.1, 7.2, 7.5_

  - [ ]* 3.2 Write property test for Rate Limit Enforcement
    - **Property 10: Rate Limit Enforcement**
    - **Validates: Requirements 7.1, 7.2**

- [x] 4. Contact management service and routes
  - [x] 4.1 Implement contact validation utilities (E.164 phone format, required fields)
    - Create `src/validators/contact.ts`
    - Validate E.164 format: `+` followed by 1-15 digits
    - Validate required fields: full_name required, at least one of phone_number or email required
    - Return structured validation errors indicating which fields are invalid/missing
    - _Requirements: 2.1, 2.5, 2.6_

  - [x] 4.2 Implement contact CRUD service with tenant-scoped queries
    - Create `src/services/contacts.ts` implementing the ContactService interface
    - All queries include `tenant_id` as mandatory filter
    - Create: generate UUID, validate input, INSERT with tenant_id
    - List: paginated SELECT (max 50 per page) with tenant_id filter
    - Update: validate input, UPDATE with tenant_id check, set updated_at timestamp
    - Delete: DELETE with tenant_id check
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 9.1_

  - [x] 4.3 Implement contact routes with Hono router
    - Create `src/routes/contacts.ts`
    - POST `/` - create contact
    - GET `/` - list contacts (with pagination query params)
    - GET `/:id` - get single contact
    - PUT `/:id` - update contact
    - DELETE `/:id` - delete contact
    - Wire validation and service calls, return proper error responses
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ]* 4.4 Write property test for Contact Validation Rejects Invalid Phone Numbers
    - **Property 3: Contact Validation Rejects Invalid Phone Numbers**
    - **Validates: Requirements 2.5**

  - [ ]* 4.5 Write property test for Contact Requires Name and Contact Info
    - **Property 4: Contact Requires Name and Contact Info**
    - **Validates: Requirements 2.1, 2.6**

- [x] 5. Checkpoint - Core middleware and contacts
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. WhatsApp operational messaging (Go-Wa)
  - [x] 6.1 Implement Go-Wa messaging service for sending messages and handling timeouts
    - Create `src/services/gowa.ts` implementing the GoWaService interface
    - `sendMessage`: POST to Go-Wa gateway with 10-second timeout; on timeout mark message as "failed" and log
    - Store outbound message in D1 with sender, recipient, timestamp, type, delivery_status, channel='gowa'
    - _Requirements: 3.1, 3.4, 3.5_

  - [x] 6.2 Implement Go-Wa incoming message webhook handler with contact linking
    - Create incoming message handler in `src/services/gowa.ts`
    - Match incoming phone number against tenant contacts; link if found, mark as unlinked if not
    - Handle media messages: upload to R2 if <= 16MB, flag as oversized if > 16MB
    - Store message in D1 with all required fields
    - _Requirements: 3.2, 3.3, 3.6, 3.7_

  - [x] 6.3 Implement message routes for agent messaging
    - Create `src/routes/messages.ts`
    - POST `/send` - send message via Go-Wa
    - GET `/` - list messages (paginated, tenant-scoped)
    - GET `/:id` - get single message
    - Wire to GoWa service
    - _Requirements: 3.1, 3.5_

  - [ ]* 6.4 Write unit tests for Go-Wa service (send, timeout, incoming message handling)
    - Test successful message send flow
    - Test 10-second timeout behavior and "failed" status
    - Test contact linking for incoming messages
    - Test media upload and oversized media handling
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6, 3.7_

- [x] 7. Broadcast messaging (Meta Cloud API)
  - [x] 7.1 Implement broadcast service with quota validation and queue enqueuing
    - Create `src/services/broadcast.ts` implementing the BroadcastService interface
    - `initiateBroadcast`: validate quota >= contact count, atomically deduct quota, enqueue each message individually to BROADCAST_QUEUE
    - Reject with 402 if insufficient quota
    - Validate broadcast contact list is 1-10,000 contacts
    - _Requirements: 4.1, 4.5, 4.6_

  - [x] 7.2 Implement broadcast queue consumer with Meta Cloud API integration and retry logic
    - Create `src/workers/broadcastConsumer.ts` as the Queue consumer handler
    - Process batch of messages (max 10 per batch) at max 80 msg/s per tenant
    - On success: update broadcast_message status to "delivered"
    - On rate-limit error: re-enqueue with exponential backoff (1s, 2s, 4s... max 300s), max 5 retries
    - On permanent failure: mark as "failed", do not retry
    - After max retries: mark as "failed"
    - _Requirements: 4.2, 4.3, 4.4, 4.7, 4.8_

  - [x] 7.3 Implement broadcast routes
    - Create `src/routes/broadcasts.ts`
    - POST `/` - initiate broadcast
    - GET `/` - list broadcasts (tenant-scoped, paginated)
    - GET `/:id` - get broadcast details with message status summary
    - GET `/:id/messages` - list broadcast messages with statuses
    - _Requirements: 4.1, 4.5_

  - [ ]* 7.4 Write property test for Broadcast Quota Deduction Invariant
    - **Property 5: Broadcast Quota Deduction Invariant**
    - **Validates: Requirements 4.1, 4.6**

  - [ ]* 7.5 Write property test for Broadcast Quota Rejection When Insufficient
    - **Property 6: Broadcast Quota Rejection When Insufficient**
    - **Validates: Requirements 4.5**

  - [ ]* 7.6 Write property test for Broadcast Retry Exponential Backoff
    - **Property 14: Broadcast Retry Exponential Backoff**
    - **Validates: Requirements 4.4, 4.8**

- [x] 8. Checkpoint - Messaging services
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Billing and payment (iPaymu)
  - [x] 9.1 Implement billing service with iPaymu payment link generation
    - Create `src/services/billing.ts` implementing the BillingService interface
    - `createPaymentLink`: call iPaymu API to generate payment URL with 24-hour expiration
    - Store transaction record in D1 (amount, status=pending, tenant_id, type, timestamps)
    - Return error 503 if iPaymu is unreachable, log failure details
    - _Requirements: 5.1, 5.2, 5.7, 5.8_

  - [x] 9.2 Implement iPaymu webhook handler with signature validation and idempotency
    - Add iPaymu webhook processing in `src/services/webhooks.ts`
    - Validate HMAC signature using shared secret BEFORE any state changes
    - Check idempotency: lookup event_id in webhook_events table; return 200 if duplicate
    - Reject with 401 if signature invalid; log security alert with source IP
    - Reject with 400 if event_id missing/empty
    - On valid success payment: activate subscription or credit quota
    - On valid failed/cancelled payment: update transaction status, no tier/quota changes
    - Must respond within 5 seconds
    - _Requirements: 5.3, 5.4, 5.5, 5.6, 5.9, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [x] 9.3 Implement billing routes
    - Create `src/routes/billing.ts`
    - POST `/payment-link` - generate payment link for subscription upgrade or quota purchase
    - GET `/transactions` - list transaction history (tenant-scoped, paginated)
    - _Requirements: 5.1, 5.2, 5.7_

  - [ ]* 9.4 Write property test for Webhook Idempotency
    - **Property 7: Webhook Idempotency**
    - **Validates: Requirements 10.2, 10.3**

  - [ ]* 9.5 Write property test for Webhook Signature Validation Gate
    - **Property 8: Webhook Signature Validation Gate**
    - **Validates: Requirements 10.1, 10.4**

- [x] 10. File and media storage
  - [x] 10.1 Implement file validation utility (size, filename length, content type)
    - Create `src/validators/file.ts`
    - Validate size: 1 byte to 16 MB
    - Validate filename: max 255 characters
    - Validate content type against allowed list (image, video, audio, PDF, document formats)
    - Return specific error for each validation failure
    - _Requirements: 6.3, 6.4, 6.6_

  - [x] 10.2 Implement file storage service with R2 tenant-namespaced uploads and presigned URLs
    - Create `src/services/files.ts` implementing the FileService interface
    - `upload`: validate file, store in R2 at `{tenant_id}/files/{file_id}/{filename}`, store metadata in D1
    - `getPresignedUrl`: verify file belongs to tenant, generate presigned URL with 60-minute expiry
    - `delete`: verify tenant ownership, remove from R2 and D1
    - Return 404 if file not found or doesn't belong to tenant
    - _Requirements: 6.1, 6.2, 6.5, 6.7, 9.2_

  - [x] 10.3 Implement file routes
    - Create `src/routes/files.ts`
    - POST `/upload` - upload file (multipart form data)
    - GET `/:id/download` - get presigned download URL
    - DELETE `/:id` - delete file
    - _Requirements: 6.1, 6.2, 6.4, 6.7_

  - [ ]* 10.4 Write property test for File Size Validation Bounds
    - **Property 9: File Size Validation Bounds**
    - **Validates: Requirements 6.3, 6.4**

  - [ ]* 10.5 Write property test for R2 Storage Namespace Isolation
    - **Property 13: R2 Storage Namespace Isolation**
    - **Validates: Requirements 9.2, 6.7**

- [x] 11. Checkpoint - Billing and file storage
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Audit trail and message logging
  - [x] 12.1 Implement message status logging service with status transition tracking
    - Create `src/services/audit.ts`
    - On every delivery_status change, insert into `message_status_log` with previous_status, new_status, changed_at
    - Integrate with message and broadcast services to trigger logging on status transitions
    - _Requirements: 8.1, 8.2_

  - [x] 12.2 Implement audit log query routes with filtering and pagination
    - Create `src/routes/audit.ts`
    - GET `/messages` - query message logs filtered by tenant, sorted by timestamp DESC
    - Support filters: date range, channel, sender, recipient, delivery_status
    - Default page size 50, max page size 200
    - Return empty result set with total=0 when no matches
    - Require audit permission via RBAC middleware
    - _Requirements: 8.3, 8.4, 8.5_

  - [ ]* 12.3 Write property test for Message Status Transition Audit Trail
    - **Property 11: Message Status Transition Audit Trail**
    - **Validates: Requirements 8.1, 8.2**

- [x] 13. Tenant data isolation enforcement
  - [x] 13.1 Implement tenant isolation guard utility and cross-tenant access violation logging
    - Create `src/middleware/tenantGuard.ts`
    - Utility function to verify resource tenant_id matches session tenant_id
    - On mismatch: return 403, log violation to D1 (requesting user ID, resource identifier, source tenant, target tenant)
    - Ensure async queue/webhook jobs also enforce tenant scoping
    - _Requirements: 9.1, 9.4, 9.5_

  - [ ]* 13.2 Write property test for Tenant Isolation on All Queries
    - **Property 1: Tenant Isolation on All Queries**
    - **Validates: Requirements 9.1, 9.4**

- [x] 14. KV caching layer
  - [x] 14.1 Implement KV caching service with configurable TTL and D1 fallback
    - Create `src/services/cache.ts`
    - Implement get/set with tenant-scoped key patterns as defined in design
    - On cache miss: fetch from D1, write back to KV with configured TTL (60s-3600s)
    - On KV unavailable: bypass cache, serve from D1, log unavailability event
    - Cache tenant config, contact pages, org-to-tenant mappings
    - _Requirements: 7.3, 7.4, 7.5, 9.3_

- [x] 15. Webhook routes and Go-Wa webhook integration
  - [x] 15.1 Implement webhook routes consolidating iPaymu and Go-Wa webhook endpoints
    - Create `src/routes/webhooks.ts`
    - POST `/ipaymu` - iPaymu payment callback (uses signature validation + idempotency from 9.2)
    - POST `/gowa` - Go-Wa incoming message callback (resolves tenant from phone mapping)
    - No auth middleware on webhook routes - use signature/token validation instead
    - _Requirements: 3.2, 5.3, 10.1, 10.3_

- [x] 16. Wire all routes and export queue consumer in main entry
  - [x] 16.1 Wire all route modules into main Hono app and export queue handler
    - Update `src/index.ts` to import and mount all route modules
    - Wire middleware chain: authMiddleware → tenantMiddleware → rateLimitMiddleware for `/api/*`
    - Mount webhook routes without auth middleware
    - Export `fetch` handler and `queue` consumer for broadcast processing
    - _Requirements: All (integration)_

- [x] 17. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The project uses TypeScript throughout with Hono framework on Cloudflare Workers
- Testing uses Vitest with `@cloudflare/vitest-pool-workers` and fast-check for property tests
- All data access is tenant-scoped via middleware; no query should omit tenant_id filtering

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4"] },
    { "id": 2, "tasks": ["2.1", "2.2", "2.3", "3.1", "4.1"] },
    { "id": 3, "tasks": ["2.4", "2.5", "3.2", "4.2", "4.3"] },
    { "id": 4, "tasks": ["4.4", "4.5", "6.1", "6.2", "7.1", "9.1", "10.1"] },
    { "id": 5, "tasks": ["6.3", "6.4", "7.2", "7.3", "9.2", "9.3", "10.2", "10.3"] },
    { "id": 6, "tasks": ["7.4", "7.5", "7.6", "9.4", "9.5", "10.4", "10.5"] },
    { "id": 7, "tasks": ["12.1", "13.1", "14.1", "15.1"] },
    { "id": 8, "tasks": ["12.2", "12.3", "13.2"] },
    { "id": 9, "tasks": ["16.1"] }
  ]
}
```
