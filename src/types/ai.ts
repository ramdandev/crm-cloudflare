/**
 * AI Sales Agent TypeScript type definitions.
 * All interfaces for the AI module including configuration, knowledge base,
 * sales pipeline, appointments, tickets, escalation, guardrails, and more.
 */

// ============================================================================
// AI Agent Configuration
// ============================================================================

export interface AIAgentConfig {
  id: string;
  tenant_id: string;
  provider_url: string;
  model_name: string;
  api_key_encrypted: string;
  system_prompt: string;
  temperature: number;
  max_tokens: number;
  context_window: number;
  language: string;
  tone: string;
  confidence_threshold: number;
  active: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Knowledge Base
// ============================================================================

export interface KnowledgeBaseEntry {
  id: string;
  tenant_id: string;
  title: string;
  content: string;
  category: string;
  tags: string | null; // JSON array
  embedding: string | null; // base64 float32 vector
  file_r2_key: string | null;
  entry_type: 'faq' | 'product' | 'policy' | 'learned';
  source: 'manual' | 'escalation' | 'bulk_import';
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Product Catalog
// ============================================================================

export interface ProductEntry {
  id: string;
  tenant_id: string;
  kb_entry_id: string | null;
  name: string;
  description: string;
  price: number;
  currency: string;
  availability: 'available' | 'out_of_stock' | 'pre_order' | 'discontinued';
  image_r2_keys: string | null; // JSON array
  custom_attributes: string | null; // JSON object
  min_price: number | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Business Rules (Guardrails)
// ============================================================================

export interface BusinessRule {
  id: string;
  tenant_id: string;
  rule_type: 'max_discount' | 'restricted_topic' | 'required_disclaimer' | 'prohibited_phrase' | 'custom';
  rule_name: string;
  rule_config: string; // JSON
  active: number;
  priority: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Sales Pipeline
// ============================================================================

export type PipelineStage = 'inquiry' | 'explanation' | 'negotiation' | 'closing' | 'invoiced' | 'paid';

export interface SalesPipeline {
  id: string;
  tenant_id: string;
  contact_id: string;
  stage: PipelineStage;
  product_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Appointments
// ============================================================================

export interface Appointment {
  id: string;
  tenant_id: string;
  contact_id: string;
  date: string;
  time_start: string;
  time_end: string;
  duration_minutes: number;
  status: 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  notes: string | null;
  reminder_24h_sent: number;
  reminder_1h_sent: number;
  created_at: string;
  updated_at: string;
}

export interface AppointmentAvailability {
  id: string;
  tenant_id: string;
  day_of_week: number; // 0=Sunday, 6=Saturday
  time_start: string; // HH:MM
  time_end: string;   // HH:MM
  slot_duration_minutes: number;
  buffer_minutes: number;
  active: number;
}

// ============================================================================
// Support Tickets
// ============================================================================

export interface SupportTicket {
  id: string;
  tenant_id: string;
  contact_id: string;
  type: 'billing' | 'technical' | 'product' | 'general';
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'in_progress' | 'escalated' | 'resolved' | 'closed';
  assigned_to: string | null;
  resolution: string | null;
  conversation_turns: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Lead Scoring
// ============================================================================

export type LeadScore = 'hot' | 'warm' | 'cold';

export interface LeadScoreRecord {
  id: string;
  tenant_id: string;
  contact_id: string;
  score: LeadScore;
  numeric_score: number;
  scoring_factors: string | null; // JSON
  last_scored_at: string;
}

// ============================================================================
// Escalation
// ============================================================================

export interface EscalationStaff {
  id: string;
  tenant_id: string;
  name: string;
  phone_number: string;
  priority_order: number;
  specialties: string | null; // JSON array
  active: number;
}

export interface PendingEscalation {
  id: string;
  tenant_id: string;
  contact_id: string;
  staff_id: string;
  correlation_id: string;
  question: string;
  context_summary: string | null;
  status: 'pending' | 'answered' | 'timeout';
  staff_response: string | null;
  created_at: string;
  responded_at: string | null;
  timeout_at: string;
}

// ============================================================================
// Conversation Summaries
// ============================================================================

export interface ConversationSummary {
  id: string;
  tenant_id: string;
  contact_id: string;
  summary: string;
  key_facts: string | null; // JSON array
  message_range_start: string;
  message_range_end: string;
  created_at: string;
}

// ============================================================================
// Token Usage
// ============================================================================

export interface TokenUsageRecord {
  id: string;
  tenant_id: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  purpose: 'conversation' | 'summary' | 'embedding' | 'guardrail';
  created_at: string;
}

// ============================================================================
// Action Triggers
// ============================================================================

export interface ActionTrigger {
  id: string;
  tenant_id: string;
  action_type: 'send_invoice' | 'create_appointment' | 'create_ticket' | 'update_pipeline' | 'notify_staff' | 'custom_webhook';
  action_name: string;
  config: string; // JSON
  parameter_schema: string; // JSON Schema
  active: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// AI Audit Log
// ============================================================================

export interface AIAuditLog {
  id: string;
  tenant_id: string;
  contact_id: string;
  input_message: string;
  kb_entries_used: string | null;
  constructed_prompt: string;
  raw_ai_response: string;
  guardrail_result: 'passed' | 'violated' | 'regenerated';
  violated_rules: string | null;
  final_sent_message: string;
  prompt_tokens: number;
  completion_tokens: number;
  response_time_ms: number;
  actions_triggered: string | null;
  created_at: string;
}

// ============================================================================
// AI Provider Interface (OpenAI-compatible)
// ============================================================================

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessage[];
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionResponse {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ============================================================================
// Queue Job Payloads
// ============================================================================

export interface AIProcessingJob {
  tenant_id: string;
  contact_id: string;
  message_id: string;
  sender_phone: string;
  message_content: string;
  message_type: string;
}

export interface ReminderJob {
  tenant_id: string;
  contact_id: string;
  appointment_id: string;
  reminder_type: '24h' | '1h';
}

// ============================================================================
// Guardrail Types
// ============================================================================

export interface GuardrailResult {
  passed: boolean;
  violations: GuardrailViolation[];
}

export interface GuardrailViolation {
  rule_id: string;
  rule_type: string;
  rule_name: string;
  violation_detail: string;
}

// ============================================================================
// Action Execution Types
// ============================================================================

export interface ActionExecutionResult {
  success: boolean;
  action_type: string;
  result_data: Record<string, unknown>;
  error?: string;
}

// ============================================================================
// Prompt Assembly Context
// ============================================================================

export interface ConversationContext {
  messages: ChatCompletionMessage[];
  summary: string | null;
  contact_history: {
    purchases: Array<{ product: string; date: string; amount: number }>;
    appointments: Array<{ date: string; status: string }>;
    tickets: Array<{ type: string; status: string; description: string }>;
  };
  kb_entries: Array<{ title: string; content: string; category: string }>;
  pipeline_stage: PipelineStage | null;
  lead_score: LeadScore | null;
}
