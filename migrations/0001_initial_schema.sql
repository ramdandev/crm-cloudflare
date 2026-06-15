-- Migration: 0001_initial_schema
-- Description: Initial D1 schema for Omnichannel SaaS CRM
-- Creates all tables, indexes, CHECK constraints, and FOREIGN KEY references

-- Core tenant table
CREATE TABLE tenants (
    id TEXT PRIMARY KEY,
    clerk_org_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    plan_tier TEXT NOT NULL DEFAULT 'free',
    broadcast_quota INTEGER NOT NULL DEFAULT 0,
    rate_limit_per_minute INTEGER NOT NULL DEFAULT 1000,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tenants_clerk_org_id ON tenants(clerk_org_id);

-- Contacts table
CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    phone_number TEXT,
    email TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CHECK (phone_number IS NOT NULL OR email IS NOT NULL)
);

CREATE INDEX idx_contacts_tenant ON contacts(tenant_id);
CREATE INDEX idx_contacts_phone ON contacts(tenant_id, phone_number);
CREATE INDEX idx_contacts_email ON contacts(tenant_id, email);

-- Messages table (all WhatsApp messages)
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    contact_id TEXT,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    message_type TEXT NOT NULL CHECK(message_type IN ('text','image','video','audio','document')),
    content TEXT,
    media_url TEXT,
    delivery_status TEXT NOT NULL CHECK(delivery_status IN ('queued','sent','delivered','read','failed')),
    channel TEXT NOT NULL CHECK(channel IN ('gowa','meta')),
    sender_phone TEXT,
    is_unlinked INTEGER NOT NULL DEFAULT 0,
    oversized_media INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE INDEX idx_messages_tenant ON messages(tenant_id, created_at DESC);
CREATE INDEX idx_messages_contact ON messages(tenant_id, contact_id);
CREATE INDEX idx_messages_channel ON messages(tenant_id, channel);
CREATE INDEX idx_messages_status ON messages(tenant_id, delivery_status);

-- Message status change log for audit trail
CREATE TABLE message_status_log (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    previous_status TEXT,
    new_status TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (message_id) REFERENCES messages(id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX idx_status_log_message ON message_status_log(message_id);
CREATE INDEX idx_status_log_tenant ON message_status_log(tenant_id, changed_at DESC);

-- Broadcasts table
CREATE TABLE broadcasts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    template_name TEXT NOT NULL,
    template_language TEXT NOT NULL DEFAULT 'en',
    total_messages INTEGER NOT NULL DEFAULT 0,
    sent_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','in_progress','completed','failed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX idx_broadcasts_tenant ON broadcasts(tenant_id, created_at DESC);

-- Individual broadcast messages
CREATE TABLE broadcast_messages (
    id TEXT PRIMARY KEY,
    broadcast_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    delivery_status TEXT NOT NULL DEFAULT 'queued' CHECK(delivery_status IN ('queued','sent','delivered','failed')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    error_detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE INDEX idx_broadcast_msgs_broadcast ON broadcast_messages(broadcast_id);
CREATE INDEX idx_broadcast_msgs_tenant ON broadcast_messages(tenant_id);
CREATE INDEX idx_broadcast_msgs_status ON broadcast_messages(broadcast_id, delivery_status);

-- Payment transactions
CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    ipaymu_trx_id TEXT,
    type TEXT NOT NULL CHECK(type IN ('subscription_upgrade','quota_purchase')),
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','failed','cancelled','expired')),
    plan_id TEXT,
    quota_amount INTEGER,
    payment_url TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX idx_transactions_tenant ON transactions(tenant_id, created_at DESC);
CREATE INDEX idx_transactions_ipaymu ON transactions(ipaymu_trx_id);

-- File metadata
CREATE TABLE files (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    r2_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX idx_files_tenant ON files(tenant_id);

-- Webhook events for idempotency
CREATE TABLE webhook_events (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT,
    source TEXT NOT NULL CHECK(source IN ('ipaymu','gowa')),
    payload TEXT,
    processed_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_webhook_events_event_id ON webhook_events(event_id);
CREATE INDEX idx_webhook_events_source ON webhook_events(source, created_at DESC);

-- Admin alerts
CREATE TABLE admin_alerts (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    type TEXT NOT NULL,
    detail TEXT,
    source_ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_admin_alerts_type ON admin_alerts(type, created_at DESC);
