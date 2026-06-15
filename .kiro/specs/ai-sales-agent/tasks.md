# Implementation Plan: AI Sales Agent

## Overview

This plan incrementally builds the AI Sales Agent feature for the existing CRM platform. It starts with database schema and TypeScript types (foundational infrastructure), then builds core AI pipeline services, knowledge base, guardrails, action triggers, escalation, appointments, tickets, lead scoring, unified inbox, and audit/analytics. Each phase is wired into the existing Hono router and Cloudflare Workers architecture.

## Tasks

- [ ] 1. Database schema and TypeScript type foundations
  - [ ] 1.1 Create D1 migration for all AI Sales Agent tables
    - Create `migrations/0002_ai_sales_agent.sql` with all 20 new tables (ai_agent_config, knowledge_base, product_catalog, business_rules, sales_pipeline, appointments, appointment_availability, support_tickets, lead_scores, lead_scoring_config, escalation_staff, pending_escalations, conversation_summaries, conversation_assignments, conversation_notes, token_usage, token_quotas, action_triggers, ai_audit_log, ai_sales_transactions)
    - Include all indexes as defined in the design
    - _Requirements: 1.1, 2.1, 2.3, 4.3, 5.1, 6.1, 7.1, 8.4, 9.6, 10.2, 11.1, 12.1, 13.1, 14.1_

  - [ ] 1.2 Create AI TypeScript type definitions
    - Create `src/types/ai.ts` with all interfaces: AIAgentConfig, KnowledgeBaseEntry, ProductEntry, BusinessRule, SalesPipeline, Appointment, AppointmentAvailability, SupportTicket, LeadScoreRecord, EscalationStaff, PendingEscalation, ConversationSummary, TokenUsageRecord, ActionTrigger, AIAuditLog, ChatCompletionMessage/Request/Response, AIProcessingJob, ReminderJob, GuardrailResult, GuardrailViolation, ActionExecutionResult, ConversationContext
    - Export all types and union/enum types (PipelineStage, LeadScore, etc.)
    - _Requirements: 1.1, 2.1, 3.1, 4.3, 5.1, 6.1, 7.1, 8.1, 9.1, 11.1, 12.1, 14.1_

  - [ ] 1.3 Update bindings and wrangler configuration
    - Update `src/types/bindings.ts` to add AI_QUEUE binding, AI_PROVIDER_URL, AI_PROVIDER_KEY env vars, and APPOINTMENT_REMINDER_QUEUE binding
    - Update `wrangler.toml` to add queue producer/consumer bindings for `ai-processing` and `appointment-reminders`, and add cron triggers for token reset and log purge
    - _Requirements: 3.1, 5.5, 11.6, 14.5_

- [ ] 2. AI Configuration service and routes
  - [ ] 2.1 Implement AIConfigService
    - Create `src/services/ai/config.ts` implementing: `get(tenantId)`, `upsert(tenantId, config)`, `validateProvider(url, apiKey)`, `invalidateCache(tenantId)`
    - Use KV caching with key pattern `ai_config:{tenant_id}` and 300s TTL
    - Validate AI provider reachability on upsert with test request
    - Encrypt API key before storage
    - _Requirements: 1.1, 1.2, 1.4, 1.5_

  - [ ]* 2.2 Write property test for AIConfigService configuration round-trip
    - **Property 1: Configuration Round-Trip**
    - **Validates: Requirements 1.1, 1.5**

  - [ ]* 2.3 Write property test for unconfigured tenant rejection
    - **Property 2: Unconfigured Tenant Rejection**
    - **Validates: Requirements 1.3**

  - [ ] 2.4 Implement AI Config routes
    - Create `src/routes/ai/config.ts` with `GET /api/ai/config` and `PUT /api/ai/config`
    - Apply existing auth, tenant, and RBAC middleware (admin-only for config)
    - Validate request body schema
    - _Requirements: 1.1, 1.2, 1.4, 1.5_

- [ ] 3. Knowledge Base service and routes
  - [ ] 3.1 Implement KnowledgeBaseService
    - Create `src/services/ai/knowledgeBase.ts` implementing: `create(entry)`, `update(id, entry)`, `delete(id)`, `getById(id)`, `list(tenantId, filters)`, `generateEmbedding(text)`, `semanticSearch(tenantId, queryEmbedding, topK)`, `bulkImport(tenantId, entries)`
    - Implement cosine similarity computation for semantic search over base64-encoded float32 vectors
    - Store file attachments in R2 under tenant-scoped prefix
    - _Requirements: 2.1, 2.2, 2.4, 2.5, 2.6_

  - [ ]* 3.2 Write property tests for Knowledge Base
    - **Property 3: Knowledge Base Entry Round-Trip**
    - **Property 4: Semantic Search Ordering**
    - **Property 5: Bulk Import Validation**
    - **Validates: Requirements 2.1, 2.3, 2.4, 2.5**

  - [ ] 3.3 Implement Product Catalog within KnowledgeBaseService
    - Add product-specific CRUD methods: `createProduct(product)`, `updateProduct(id, product)`, `listProducts(tenantId, filters)` with availability filtering
    - Link products to KB entries via kb_entry_id for semantic search
    - _Requirements: 2.3_

  - [ ] 3.4 Implement Knowledge Base and Products routes
    - Create `src/routes/ai/knowledgeBase.ts` with CRUD endpoints for `/api/ai/knowledge-base` and `POST /api/ai/knowledge-base/bulk`
    - Create `src/routes/ai/products.ts` with CRUD endpoints for `/api/ai/products`
    - Apply auth, tenant, RBAC middleware
    - _Requirements: 2.1, 2.3, 2.5_

- [ ] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Core AI Pipeline and Prompt Builder
  - [ ] 5.1 Implement PromptBuilder service
    - Create `src/services/ai/promptBuilder.ts` implementing: `buildPrompt(config, context)` that assembles system prompt + conversation summary + contact history (purchases, appointments, tickets) + KB search results + recent messages in the correct order
    - Handle token budget estimation to avoid exceeding model context limits
    - _Requirements: 3.1, 3.2, 3.4, 10.3, 10.4, 10.5_

  - [ ]* 5.2 Write property test for prompt assembly
    - **Property 7: Prompt Assembly Completeness**
    - **Validates: Requirements 3.1, 10.3, 10.4, 10.5**

  - [ ] 5.3 Implement ConversationService
    - Create `src/services/ai/conversations.ts` implementing: `loadContext(tenantId, contactId, windowSize)`, `generateSummary(tenantId, contactId, messages)`, `isHumanTakeover(tenantId, contactId)`, `assignConversation(tenantId, contactId, userId)`, `releaseConversation(tenantId, contactId)`, `addNote(tenantId, contactId, userId, content, tags)`, `listConversations(tenantId, filters)`
    - Check human takeover via KV key `human_takeover:{tenant_id}:{contact_id}`
    - _Requirements: 3.2, 3.3, 10.1, 10.2, 13.1, 13.2, 13.3, 13.4_

  - [ ]* 5.4 Write property tests for conversation context
    - **Property 6: Context Window Loading**
    - **Property 28: Human Takeover Round-Trip**
    - **Property 29: Internal Notes Isolation**
    - **Validates: Requirements 3.2, 10.1, 13.2, 13.3, 13.4**

  - [ ] 5.5 Implement AIPipelineService
    - Create `src/services/ai/pipeline.ts` implementing: `processMessage(job: AIProcessingJob)` that orchestrates the full pipeline: check config → check human takeover → check token quota → load context → semantic search KB → build prompt → call AI provider → run guardrails → extract actions → execute actions → update pipeline/lead score → record tokens → write audit → send response via GoWa
    - Implement AI provider client with OpenAI-compatible chat completions format
    - Implement circuit breaker pattern with KV state at `ai_circuit:{tenant_id}`
    - _Requirements: 3.1, 3.4, 3.5, 3.6, 4.1, 4.3_

  - [ ] 5.6 Implement AI Queue Consumer
    - Create `src/workers/aiConsumer.ts` that consumes AIProcessingJob messages from the AI_QUEUE and invokes `AIPipelineService.processMessage()`
    - Handle retry logic with exponential backoff (max 3 retries)
    - _Requirements: 3.1_

- [ ] 6. Guardrail Engine
  - [ ] 6.1 Implement GuardrailEngine service
    - Create `src/services/ai/guardrails.ts` implementing: `validateResponse(tenantId, response, context)` that checks response against all active business rules (prohibited phrases, restricted topics, max discount enforcement, required disclaimers)
    - Implement hallucination detection: verify factual claims trace to KB entries or conversation context
    - Implement confidence threshold checking for uncertainty responses
    - Return `GuardrailResult` with list of violations
    - _Requirements: 3.5, 8.1, 8.2, 8.3, 8.6_

  - [ ]* 6.2 Write property tests for Guardrail Engine
    - **Property 8: Guardrail Rule Validation**
    - **Property 9: Hallucination Detection**
    - **Property 11: Discount Constraint Enforcement**
    - **Property 19: Uncertainty Threshold Trigger**
    - **Validates: Requirements 3.5, 8.1, 8.2, 4.4, 8.6**

  - [ ] 6.3 Implement Business Rules CRUD routes
    - Create `src/routes/ai/rules.ts` with CRUD endpoints for `/api/ai/rules`
    - Support rule types: max_discount, restricted_topic, required_disclaimer, prohibited_phrase, custom
    - Apply auth, tenant, RBAC middleware
    - _Requirements: 8.4_

  - [ ]* 6.4 Write property test for business rule configuration
    - **Property 18: Business Rule Configuration Round-Trip**
    - **Validates: Requirements 8.4**

- [ ] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Action Triggers and Sales Pipeline
  - [ ] 8.1 Implement ActionTriggerService
    - Create `src/services/ai/actions.ts` implementing: `registerAction(tenantId, action)`, `executeAction(tenantId, actionType, params)`, `validateParams(actionType, params, schema)`, `listActions(tenantId)`
    - Implement action executors for: send_invoice (via existing BillingService), create_appointment, create_ticket, update_pipeline, notify_staff, custom_webhook
    - Validate parameters against JSON Schema before execution
    - Emit webhook notifications on action completion
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

  - [ ]* 8.2 Write property test for action trigger schema validation
    - **Property 27: Action Trigger Schema Validation**
    - **Validates: Requirements 12.3**

  - [ ] 8.3 Implement Sales Pipeline tracking
    - Add pipeline stage tracking within `AIPipelineService`: detect purchase intent, update pipeline stage (inquiry → explanation → negotiation → closing → invoiced → paid)
    - Enforce discount rules via GuardrailEngine during negotiation
    - Trigger invoice generation via ActionTriggerService on sale confirmation
    - Record transactions in ai_sales_transactions table
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [ ]* 8.4 Write property test for pipeline state validity
    - **Property 10: Pipeline State Validity**
    - **Validates: Requirements 4.3**

- [ ] 9. Escalation Service
  - [ ] 9.1 Implement EscalationService
    - Create `src/services/ai/escalation.ts` implementing: `escalateToStaff(tenantId, contactId, question, context)`, `handleStaffResponse(correlationId, response)`, `addKnowledgeFromResponse(tenantId, question, answer)`, `parseStaffCommand(message)`, `checkTimeout(escalationId)`, `configureStaff(tenantId, staff[])`
    - Generate correlation_id for tracking staff replies
    - Format escalation messages naturally (like a colleague asking for help)
    - Create KB entries from staff responses with entry_type='learned', source='escalation'
    - Support staff command format: `#KB: <title> | <content> | <category>`
    - Handle timeout (default 30 min) → create support ticket + notify customer
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_

  - [ ]* 9.2 Write property tests for escalation
    - **Property 20: Escalation Message Formatting**
    - **Property 21: Dynamic Knowledge Learning**
    - **Property 22: Staff Command Parsing**
    - **Validates: Requirements 9.2, 9.5, 9.8**

  - [ ] 9.3 Implement Escalation Config routes
    - Create `src/routes/ai/escalation.ts` with CRUD endpoints for `/api/ai/escalation/staff`
    - Support priority ordering and specialty configuration
    - Apply auth, tenant, RBAC middleware
    - _Requirements: 9.6_

- [ ] 10. Appointment Scheduling
  - [ ] 10.1 Implement AppointmentService
    - Create `src/services/ai/appointments.ts` implementing: `configureAvailability(tenantId, slots[])`, `getAvailableSlots(tenantId, date)`, `bookAppointment(tenantId, contactId, date, timeStart, duration)`, `cancelAppointment(id)`, `listAppointments(tenantId, filters)`, `sendReminder(appointmentId, type)`
    - Detect conflicts considering buffer time between appointments
    - Suggest nearest alternatives when requested slot is taken
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6_

  - [ ]* 10.2 Write property tests for appointments
    - **Property 12: Appointment Slot Availability**
    - **Property 13: Appointment Booking Round-Trip**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.6**

  - [ ] 10.3 Implement Appointment Reminder Consumer
    - Create `src/workers/reminderConsumer.ts` that consumes ReminderJob messages and sends 24h/1h reminders via GoWaService
    - Mark reminder_24h_sent and reminder_1h_sent flags on appointment record
    - _Requirements: 5.5_

  - [ ] 10.4 Implement Appointments routes
    - Create `src/routes/ai/appointments.ts` with CRUD endpoints for `/api/ai/appointments` and `GET /api/ai/appointments/available`
    - Apply auth, tenant, RBAC middleware
    - _Requirements: 5.1, 5.2, 5.3_

- [ ] 11. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 12. Support Tickets and Lead Scoring
  - [ ] 12.1 Implement SupportTicketService
    - Create `src/services/ai/tickets.ts` implementing: `createTicket(tenantId, contactId, type, description, priority)`, `updateStatus(id, status, resolution?)`, `listTickets(tenantId, filters)`, `assignTicket(id, assignedTo)`, `autoCategorizfromConversation(messages)`
    - Implement 2-turn escalation threshold: if AI cannot resolve within 2 turns, auto-escalate
    - Send status change notifications to customer via GoWaService
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [ ]* 12.2 Write property tests for support tickets
    - **Property 14: Support Ticket Round-Trip and Filtering**
    - **Property 15: Escalation Turn Threshold**
    - **Validates: Requirements 6.1, 6.4, 6.5**

  - [ ] 12.3 Implement Tickets routes
    - Create `src/routes/ai/tickets.ts` with CRUD endpoints for `/api/ai/tickets`
    - Support filtering by status, priority, type, and contact
    - Apply auth, tenant, RBAC middleware
    - _Requirements: 6.5_

  - [ ] 12.4 Implement LeadScorerService
    - Create `src/services/ai/leadScorer.ts` implementing: `scoreContact(tenantId, contactId, messageContent)`, `getScore(tenantId, contactId)`, `configureScoring(tenantId, factors[])`, `notifyHotLead(tenantId, contactId, summary)`
    - Calculate numeric score as sum of matching factor weights
    - Map numeric score to categorical (hot/warm/cold) based on configurable thresholds
    - Cache scores in KV at `lead_score:{tenant_id}:{contact_id}` with 300s TTL
    - Notify staff via GoWa when contact becomes hot
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ]* 12.5 Write property test for lead scoring
    - **Property 16: Lead Scoring Consistency**
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4**

- [ ] 13. Token Tracking and Quota Enforcement
  - [ ] 13.1 Implement TokenTrackerService
    - Create `src/services/ai/tokenTracker.ts` implementing: `recordUsage(tenantId, model, promptTokens, completionTokens, purpose)`, `getMonthlyUsage(tenantId)`, `checkQuota(tenantId)`, `getUsageHistory(tenantId, dateRange)`, `resetMonthlyCounters()`, `sendQuotaWarning(tenantId)`
    - Maintain running monthly total in KV at `token_usage:{tenant_id}:{YYYY-MM}` with 3600s TTL
    - Enforce quota: reject processing when monthly limit reached
    - Send warning when usage reaches configurable threshold (default 80%)
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

  - [ ]* 13.2 Write property tests for token tracking
    - **Property 23: Token Usage Tracking Accuracy**
    - **Property 24: Quota Enforcement**
    - **Property 25: Usage API Correctness**
    - **Property 26: Quota Warning Threshold**
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5**

  - [ ] 13.3 Implement Token Usage routes
    - Create `src/routes/ai/tokens.ts` with `GET /api/ai/tokens/usage` returning current usage, remaining quota, and history
    - Apply auth, tenant middleware
    - _Requirements: 11.4_

- [ ] 14. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 15. Unified Conversation Inbox and Analytics
  - [ ] 15.1 Implement Conversation routes
    - Create `src/routes/ai/conversations.ts` with endpoints: `GET /api/ai/conversations` (paginated, grouped by contact), `POST /api/ai/conversations/:contactId/assign`, `POST /api/ai/conversations/:contactId/release`, `POST /api/ai/conversations/:contactId/notes`
    - Include pipeline stage, lead score, and active ticket count per thread
    - Apply auth, tenant, RBAC middleware
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

  - [ ]* 15.2 Write property test for conversation thread metadata
    - **Property 30: Conversation Thread Metadata Completeness**
    - **Validates: Requirements 13.5**

  - [ ] 15.3 Implement AIAuditService
    - Create `src/services/ai/audit.ts` implementing: `logInteraction(entry: AIAuditLog)`, `listLogs(tenantId, filters)`, `getAnalytics(tenantId, dateRange)`, `purgeExpiredLogs(retentionDays)`
    - Aggregate metrics: total conversations, messages processed, actions triggered, escalations, average response time, lead conversion rate
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_

  - [ ]* 15.4 Write property tests for audit and analytics
    - **Property 17: Guardrail Violation Audit Completeness**
    - **Property 31: Audit Log Completeness**
    - **Property 32: Analytics Aggregation Correctness**
    - **Validates: Requirements 14.1, 14.3, 14.4**

  - [ ] 15.5 Implement Analytics routes
    - Create `src/routes/ai/analytics.ts` with `GET /api/ai/analytics` (aggregated metrics) and `GET /api/ai/audit-logs` (paginated logs with date-range filtering)
    - Apply auth, tenant, RBAC middleware (admin-only)
    - _Requirements: 14.2, 14.4_

- [ ] 16. Webhook Integration and Route Wiring
  - [ ] 16.1 Modify webhook handler for AI processing trigger
    - Update `src/routes/webhooks.ts` to detect incoming messages and enqueue AIProcessingJob to AI_QUEUE after storing the message
    - Check for escalation correlation_id in staff replies and route to EscalationService
    - Check for staff KB commands and route to EscalationService.parseStaffCommand()
    - _Requirements: 3.1, 9.4, 9.8_

  - [ ] 16.2 Register all new routes in main application
    - Update `src/index.ts` to import and register all new route modules under `/api/ai/` prefix: config, knowledgeBase, products, appointments, tickets, conversations, analytics, tokens, rules, escalation
    - Register queue consumers: aiConsumer, reminderConsumer
    - Register cron trigger handlers for token reset and log purge
    - _Requirements: All_

  - [ ] 16.3 Implement scheduled workers (cron triggers)
    - Add cron handler in main worker for monthly token counter reset (1st of each month)
    - Add cron handler for audit log purge (daily, retention configurable default 90 days)
    - Add cron handler for appointment reminder scheduling (check upcoming appointments, enqueue reminders)
    - _Requirements: 11.6, 14.5, 5.5_

- [ ] 17. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (32 properties total)
- Unit tests validate specific examples and edge cases
- The design uses TypeScript throughout, targeting Cloudflare Workers with Hono framework
- All new services follow existing patterns: tenant isolation, KV caching, D1 storage, R2 for files
- The AI pipeline is async via Cloudflare Queues to avoid blocking webhook responses

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1", "3.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "3.2", "3.3"] },
    { "id": 3, "tasks": ["3.4", "5.1", "5.3"] },
    { "id": 4, "tasks": ["5.2", "5.4", "5.5", "6.1"] },
    { "id": 5, "tasks": ["5.6", "6.2", "6.3", "6.4"] },
    { "id": 6, "tasks": ["8.1", "9.1", "10.1", "12.1", "12.4", "13.1"] },
    { "id": 7, "tasks": ["8.2", "8.3", "9.2", "9.3", "10.2", "10.3", "10.4", "12.2", "12.3", "12.5", "13.2", "13.3"] },
    { "id": 8, "tasks": ["8.4", "15.1", "15.3"] },
    { "id": 9, "tasks": ["15.2", "15.4", "15.5"] },
    { "id": 10, "tasks": ["16.1", "16.2", "16.3"] }
  ]
}
```
