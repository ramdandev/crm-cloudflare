/**
 * Shared TypeScript types and interfaces for the Omnichannel SaaS CRM platform.
 * All service interfaces, data models, and utility types are defined here.
 */

// Re-export bindings types
export type { Bindings, Variables } from './bindings';

// Re-export AI types
export type {
  AIAgentConfig,
  KnowledgeBaseEntry,
  ProductEntry,
  BusinessRule,
  SalesPipeline,
  PipelineStage,
  Appointment,
  AppointmentAvailability,
  SupportTicket,
  LeadScoreRecord,
  LeadScore,
  EscalationStaff,
  PendingEscalation,
  ConversationSummary,
  TokenUsageRecord,
  ActionTrigger,
  AIAuditLog,
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  AIProcessingJob,
  ReminderJob,
  GuardrailResult,
  GuardrailViolation,
  ActionExecutionResult,
  ConversationContext,
} from './ai';

// ============================================================================
// Common / Utility Types
// ============================================================================

/**
 * Paginated result wrapper for list endpoints.
 * All paginated queries return data in this format.
 */
export interface PaginatedResult<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

/**
 * Standard error response format for all API errors.
 */
export interface ErrorResponse {
  /** Machine-readable error code */
  error: string;
  /** Human-readable explanation */
  detail?: string;
  /** Field name for validation errors */
  field?: string;
  /** Seconds until retry (for 429 responses) */
  retryAfter?: number;
}

/**
 * Generic validation result returned by validators.
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// ============================================================================
// Tenant Types
// ============================================================================

/**
 * Tenant record representing a single organization in the platform.
 * Maps to the `tenants` table in D1.
 */
export interface Tenant {
  id: string;
  clerk_org_id: string;
  name: string;
  plan_tier: 'free' | 'starter' | 'professional' | 'enterprise';
  broadcast_quota: number;
  rate_limit_per_minute: number;
  active: number; // 1 = active, 0 = inactive (D1 uses integer for booleans)
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Contact Types
// ============================================================================

/**
 * Contact record stored in D1.
 * Maps to the `contacts` table.
 */
export interface Contact {
  id: string;
  tenant_id: string;
  full_name: string;
  phone_number: string | null;
  email: string | null;
  metadata: string | null; // JSON string
  created_at: string;
  updated_at: string;
}

/**
 * Input for creating a new contact.
 * Requires full_name and at least one of phone_number or email.
 */
export interface CreateContactInput {
  full_name: string;
  phone_number?: string;
  email?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Input for updating an existing contact.
 * All fields are optional; only provided fields are updated.
 */
export interface UpdateContactInput {
  full_name?: string;
  phone_number?: string;
  email?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// WhatsApp Messaging Types (Go-Wa)
// ============================================================================

/** Supported message types for WhatsApp */
export type MessageType = 'text' | 'image' | 'video' | 'audio' | 'document';

/** Delivery status for all messages */
export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

/** Channel identifier for message routing */
export type MessageChannel = 'gowa' | 'meta';

/**
 * Go-Wa specific message record.
 * Represents a message sent or received via the Go-Wa gateway.
 */
export interface GoWaMessage {
  id: string;
  tenant_id: string;
  contact_id: string | null;
  sender: string;
  recipient: string;
  message_type: MessageType;
  content: string;
  media_url: string | null;
  delivery_status: DeliveryStatus;
  channel: 'gowa';
  created_at: string;
  updated_at: string;
}

/**
 * Full message record from the D1 messages table.
 * Includes all columns for both Go-Wa and Meta channels.
 */
export interface Message {
  id: string;
  tenant_id: string;
  contact_id: string | null;
  sender: string;
  recipient: string;
  message_type: MessageType;
  content: string | null;
  media_url: string | null;
  delivery_status: DeliveryStatus;
  channel: MessageChannel;
  sender_phone: string | null;
  is_unlinked: number; // 1 if no contact match, 0 otherwise
  oversized_media: number; // 1 if media > 16MB, 0 otherwise
  created_at: string;
  updated_at: string;
}

/**
 * Payload received from Go-Wa webhook for incoming messages.
 */
export interface GoWaWebhookPayload {
  from: string;
  message: string;
  type: string;
  timestamp: number;
  media_url?: string;
  media_size?: number;
}

/**
 * Payload for media messages received via Go-Wa.
 * Used by handleMediaMessage to process media uploads.
 */
export interface GoWaMediaPayload {
  media_url: string;
  media_size: number;
  content_type: string;
  filename: string;
  message_id: string;
}

// ============================================================================
// Broadcast Types (Meta Cloud API)
// ============================================================================

/**
 * Request payload for initiating a broadcast.
 * Sends a WhatsApp template message to a list of contacts.
 */
export interface BroadcastRequest {
  template_name: string;
  template_language: string;
  contact_ids: string[];
  template_params?: Record<string, string>[];
}

/**
 * Result returned after a broadcast is initiated.
 */
export interface BroadcastResult {
  broadcast_id: string;
  total_messages: number;
  status: 'queued' | 'partial' | 'failed';
}

/**
 * Message payload placed in Cloudflare Queue for broadcast processing.
 */
export interface QueueMessage {
  broadcast_id: string;
  tenant_id: string;
  contact_phone: string;
  template_name: string;
  template_language: string;
  template_params?: Record<string, string>;
  retry_count: number;
  max_retries: number;
}

/**
 * Broadcast record stored in D1.
 * Maps to the `broadcasts` table.
 */
export interface Broadcast {
  id: string;
  tenant_id: string;
  template_name: string;
  template_language: string;
  total_messages: number;
  sent_count: number;
  failed_count: number;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  created_at: string;
  completed_at: string | null;
}

/**
 * Individual broadcast message record.
 * Maps to the `broadcast_messages` table.
 */
export interface BroadcastMessage {
  id: string;
  broadcast_id: string;
  tenant_id: string;
  contact_id: string;
  phone_number: string;
  delivery_status: 'queued' | 'sent' | 'delivered' | 'failed';
  retry_count: number;
  error_detail: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Billing Types (iPaymu)
// ============================================================================

/** Payment/transaction type */
export type TransactionType = 'subscription_upgrade' | 'quota_purchase';

/** Transaction status */
export type TransactionStatus = 'pending' | 'success' | 'failed' | 'cancelled' | 'expired';

/**
 * Request to create a payment link via iPaymu.
 */
export interface PaymentRequest {
  tenant_id: string;
  type: TransactionType;
  plan_id?: string;
  quota_amount?: number;
  amount: number;
  description: string;
}

/**
 * Result from payment link creation.
 */
export interface PaymentLinkResult {
  payment_url: string;
  transaction_id: string;
  expires_at: string;
}

/**
 * Webhook payload received from iPaymu after payment processing.
 */
export interface IPaymuWebhook {
  trx_id: string;
  status: string;
  status_code: string;
  sid: string;
  amount: number;
  reference_id: string;
  signature: string;
}

/**
 * Transaction record stored in D1.
 * Maps to the `transactions` table.
 */
export interface Transaction {
  id: string;
  tenant_id: string;
  ipaymu_trx_id: string | null;
  type: TransactionType;
  amount: number;
  status: TransactionStatus;
  plan_id: string | null;
  quota_amount: number | null;
  payment_url: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// File Storage Types
// ============================================================================

/**
 * File metadata record stored in D1.
 * Maps to the `files` table.
 */
export interface FileMetadata {
  id: string;
  tenant_id: string;
  filename: string;
  content_type: string;
  size: number;
  r2_key: string;
  created_at: string;
}

// ============================================================================
// Webhook and Audit Types
// ============================================================================

/**
 * Webhook event record for idempotency checking.
 * Maps to the `webhook_events` table.
 */
export interface WebhookEvent {
  id: string;
  event_id: string;
  tenant_id: string | null;
  source: 'ipaymu' | 'gowa';
  payload: string | null; // JSON string
  processed_at: string;
  created_at: string;
}

/**
 * Admin alert record for tracking system events.
 * Maps to the `admin_alerts` table.
 */
export interface AdminAlert {
  id: string;
  type: string;
  detail: string | null;
  source_ip: string | null;
  created_at: string;
}

/**
 * Message status transition log entry.
 * Maps to the `message_status_log` table.
 */
export interface MessageStatusLog {
  id: string;
  message_id: string;
  tenant_id: string;
  previous_status: string | null;
  new_status: string;
  changed_at: string;
}
