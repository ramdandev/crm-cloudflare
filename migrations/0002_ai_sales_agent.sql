-- Migration: 0002_ai_sales_agent
-- Description: AI Sales Agent tables for autonomous conversational AI module
-- Creates all 20 new tables, indexes, CHECK constraints, and FOREIGN KEY references

-- 1. AI Agent Configuration per tenant
CREATE TABLE ai_agent_config (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL UNIQUE,
    provider_url TEXT NOT NULL,
    model_name TEXT NOT NULL,
    api_key_encrypted TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    temperature REAL NOT NULL DEFAULT 0.7,
    max_tokens INTEGER NOT NULL DEFAULT 1024,
    context_window INTEGER NOT NULL DEFAULT 20,
    language TEXT NOT NULL DEFAULT 'id',
    tone TEXT NOT NULL DEFAULT 'friendly_professional',
    confidence_threshold REAL NOT NULL DEFAULT 0.7,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- 2. Knowledge Base entries
CREATE TABLE knowledge_base (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    tags TEXT, -- JSON array
    embedding TEXT, -- base64-encoded float32 vector
    file_r2_key TEXT,
    entry_type TEXT NOT NULL DEFAULT 'faq' CHECK(entry_type IN ('faq','product','policy','learned')),
    source TEXT DEFAULT 'manual' CHECK(source IN ('manual','escalation','bulk_import')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX idx_kb_tenant ON knowledge_base(tenant_id);
CREATE INDEX idx_kb_category ON knowledge_base(tenant_id, category);
CREATE INDEX idx_kb_type ON knowledge_base(tenant_id, entry_type);

-- 3. Product Catalog (specialized KB entries)
CREATE TABLE product_catalog (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    kb_entry_id TEXT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    price INTEGER NOT NULL, -- in smallest currency unit (e.g., IDR)
    currency TEXT NOT NULL DEFAULT 'IDR',
    availability TEXT NOT NULL DEFAULT 'available' CHECK(availability IN ('available','out_of_stock','pre_order','discontinued')),
    image_r2_keys TEXT, -- JSON array of R2 keys
    custom_attributes TEXT, -- JSON object
    min_price INTEGER, -- minimum allowed after discount
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (kb_entry_id) REFERENCES knowledge_base(id)
);

CREATE INDEX idx_products_tenant ON product_catalog(tenant_id);
CREATE INDEX idx_products_availability ON product_catalog(tenant_id, availability);

-- 4. Business Rules for guardrails
CREATE TABLE business_rules (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    rule_type TEXT NOT NULL CHECK(rule_type IN ('max_discount','restricted_topic','required_disclaimer','prohibited_phrase','custom')),
    rule_name TEXT NOT NULL,
    rule_config TEXT NOT NULL, -- JSON: varies by type
    active INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX idx_rules_tenant ON business_rules(tenant_id, active);

-- 5. Sales Pipeline tracking
CREATE TABLE sales_pipeline (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'inquiry' CHECK(stage IN ('inquiry','explanation','negotiation','closing','invoiced','paid')),
    product_id TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (contact_id) REFERENCES contacts(id),
    FOREIGN KEY (product_id) REFERENCES product_catalog(id)
);

CREATE INDEX idx_pipeline_tenant ON sales_pipeline(tenant_id, stage);
CREATE INDEX idx_pipeline_contact ON sales_pipeline(tenant_id, contact_id);

-- 6. Appointments
CREATE TABLE appointments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    date TEXT NOT NULL,
    time_start TEXT NOT NULL,
    time_end TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','cancelled','completed','no_show')),
    notes TEXT,
    reminder_24h_sent INTEGER NOT NULL DEFAULT 0,
    reminder_1h_sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE INDEX idx_appointments_tenant ON appointments(tenant_id, date);
CREATE INDEX idx_appointments_contact ON appointments(tenant_id, contact_id);

-- 7. Appointment availability configuration
CREATE TABLE appointment_availability (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
    time_start TEXT NOT NULL,
    time_end TEXT NOT NULL,
    slot_duration_minutes INTEGER NOT NULL DEFAULT 60,
    buffer_minutes INTEGER NOT NULL DEFAULT 15,
    active INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX idx_availability_tenant ON appointment_availability(tenant_id, day_of_week);

-- 8. Support Tickets
CREATE TABLE support_tickets (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('billing','technical','product','general')),
    description TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','escalated','resolved','closed')),
    assigned_to TEXT,
    resolution TEXT,
    conversation_turns INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE INDEX idx_tickets_tenant ON support_tickets(tenant_id, status);
CREATE INDEX idx_tickets_priority ON support_tickets(tenant_id, priority);
CREATE INDEX idx_tickets_contact ON support_tickets(tenant_id, contact_id);

-- 9. Lead Scoring
CREATE TABLE lead_scores (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    score TEXT NOT NULL DEFAULT 'cold' CHECK(score IN ('hot','warm','cold')),
    numeric_score INTEGER NOT NULL DEFAULT 0,
    scoring_factors TEXT, -- JSON array of factor contributions
    last_scored_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE INDEX idx_lead_scores_tenant ON lead_scores(tenant_id, score);
CREATE INDEX idx_lead_scores_contact ON lead_scores(tenant_id, contact_id);

-- 10. Lead Scoring Configuration
CREATE TABLE lead_scoring_config (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    factor_type TEXT NOT NULL CHECK(factor_type IN ('keyword','pattern','timing','engagement')),
    factor_config TEXT NOT NULL, -- JSON: keywords, regex patterns, etc.
    weight INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX idx_scoring_config_tenant ON lead_scoring_config(tenant_id);

-- 11. Escalation staff contacts
CREATE TABLE escalation_staff (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    priority_order INTEGER NOT NULL DEFAULT 0,
    specialties TEXT, -- JSON array of categories
    active INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX idx_escalation_staff_tenant ON escalation_staff(tenant_id, priority_order);

-- 12. Pending escalations
CREATE TABLE pending_escalations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    staff_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL UNIQUE,
    question TEXT NOT NULL,
    context_summary TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','timeout')),
    staff_response TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    responded_at TEXT,
    timeout_at TEXT NOT NULL,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (contact_id) REFERENCES contacts(id),
    FOREIGN KEY (staff_id) REFERENCES escalation_staff(id)
);

CREATE INDEX idx_escalations_correlation ON pending_escalations(correlation_id);
CREATE INDEX idx_escalations_tenant ON pending_escalations(tenant_id, status);
CREATE INDEX idx_escalations_timeout ON pending_escalations(status, timeout_at);

-- 13. Conversation summaries
CREATE TABLE conversation_summaries (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    key_facts TEXT, -- JSON array
    message_range_start TEXT NOT NULL,
    message_range_end TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE INDEX idx_summaries_contact ON conversation_summaries(tenant_id, contact_id);

-- 14. Human takeover state (conversation assignments)
CREATE TABLE conversation_assignments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    assigned_user_id TEXT NOT NULL,
    assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
    released_at TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE INDEX idx_assignments_active ON conversation_assignments(tenant_id, contact_id, active);

-- 15. Conversation notes (internal)
CREATE TABLE conversation_notes (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT, -- JSON array
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE INDEX idx_notes_contact ON conversation_notes(tenant_id, contact_id);

-- 16. Token usage tracking
CREATE TABLE token_usage (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'conversation' CHECK(purpose IN ('conversation','summary','embedding','guardrail')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_token_usage_tenant ON token_usage(tenant_id, created_at);
CREATE INDEX idx_token_usage_monthly ON token_usage(tenant_id, created_at);

-- 17. Token quota configuration
CREATE TABLE token_quotas (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL UNIQUE,
    monthly_limit INTEGER NOT NULL DEFAULT 1000000,
    warning_threshold REAL NOT NULL DEFAULT 0.8,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- 18. Action trigger registry
CREATE TABLE action_triggers (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK(action_type IN ('send_invoice','create_appointment','create_ticket','update_pipeline','notify_staff','custom_webhook')),
    action_name TEXT NOT NULL,
    config TEXT NOT NULL, -- JSON: webhook URL, parameter schema, etc.
    parameter_schema TEXT NOT NULL, -- JSON Schema for validation
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX idx_actions_tenant ON action_triggers(tenant_id, action_type);

-- 19. AI interaction audit log
CREATE TABLE ai_audit_log (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    input_message TEXT NOT NULL,
    kb_entries_used TEXT, -- JSON array of KB entry IDs
    constructed_prompt TEXT NOT NULL,
    raw_ai_response TEXT NOT NULL,
    guardrail_result TEXT NOT NULL CHECK(guardrail_result IN ('passed','violated','regenerated')),
    violated_rules TEXT, -- JSON array of rule IDs
    final_sent_message TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    response_time_ms INTEGER NOT NULL,
    actions_triggered TEXT, -- JSON array
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ai_audit_tenant ON ai_audit_log(tenant_id, created_at);
CREATE INDEX idx_ai_audit_guardrail ON ai_audit_log(tenant_id, guardrail_result);

-- 20. Sales transactions (AI-initiated invoices)
CREATE TABLE ai_sales_transactions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    product_id TEXT,
    pipeline_id TEXT,
    amount INTEGER NOT NULL,
    discount_percent REAL NOT NULL DEFAULT 0,
    final_amount INTEGER NOT NULL,
    payment_link_url TEXT,
    payment_status TEXT NOT NULL DEFAULT 'pending' CHECK(payment_status IN ('pending','paid','expired','cancelled')),
    ipaymu_transaction_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (contact_id) REFERENCES contacts(id),
    FOREIGN KEY (product_id) REFERENCES product_catalog(id),
    FOREIGN KEY (pipeline_id) REFERENCES sales_pipeline(id)
);

CREATE INDEX idx_ai_sales_tenant ON ai_sales_transactions(tenant_id, payment_status);
CREATE INDEX idx_ai_sales_contact ON ai_sales_transactions(tenant_id, contact_id);
