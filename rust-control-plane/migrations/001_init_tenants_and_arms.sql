-- ============================================================================
-- KA-POSONG MULTI-TENANT MAIL SUITE & UMANG IDENTITY SCHEMA
-- Migration: 001_init_tenants_and_arms.sql
-- ============================================================================

PRAGMA foreign_keys = ON;

-- 1. TENANTS TABLE (Business Tiers, Quotas, Scoped API Keys)
CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY NOT NULL,
    org_name TEXT NOT NULL,
    tier TEXT NOT NULL CHECK (tier IN ('STARTER', 'GROWTH', 'ENTERPRISE')),
    api_key_hash TEXT NOT NULL,
    raw_api_key TEXT NOT NULL,
    max_domains INTEGER NOT NULL,
    max_mailboxes INTEGER NOT NULL,
    storage_quota_bytes INTEGER NOT NULL,
    outbound_daily_limit INTEGER NOT NULL DEFAULT 100,
    allow_extending_arms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. DOMAINS TABLE (Tenant Domains, Auto-DKIM Keys, DNS Verification Status)
CREATE TABLE IF NOT EXISTS domains (
    domain_name TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    dkim_selector TEXT NOT NULL DEFAULT 'kaposong',
    dkim_public_key TEXT NOT NULL,
    umail_path TEXT NOT NULL DEFAULT '/umail',
    verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- 3. MAILBOXES & UMANG PHONE IDENTITY BINDING TABLE
-- Strictly binds a Lesotho E.164 phone number (+266########) to a tenant mailbox
CREATE TABLE IF NOT EXISTS mailboxes (
    email TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    domain_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('owner', 'admin', 'manager', 'user', 'viewer')),
    stalwart_secret TEXT NOT NULL,
    quota_bytes INTEGER NOT NULL DEFAULT 1073741824,
    whatsapp_otp_enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (domain_name) REFERENCES domains(domain_name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mailboxes_phone ON mailboxes(phone);
CREATE INDEX IF NOT EXISTS idx_mailboxes_tenant ON mailboxes(tenant_id);

-- 4. EXTENDING ARM MODULES TABLE (CRM, Billing, WhatsApp Notification Arms)
CREATE TABLE IF NOT EXISTS extending_arms (
    module_id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    module_name TEXT NOT NULL,
    webhook_url TEXT NOT NULL,
    hmac_secret TEXT NOT NULL,
    api_key_hash TEXT NOT NULL,
    raw_api_key TEXT NOT NULL,
    scopes TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- 5. LOCAL MAIL MESSAGES CACHE / INBOX INDEX (Bridges Stalwart JMAP/SMTP & Instant uMail PWA)
CREATE TABLE IF NOT EXISTS mail_messages (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    mailbox_email TEXT NOT NULL,
    folder TEXT NOT NULL DEFAULT 'inbox' CHECK (folder IN ('inbox', 'sent', 'drafts', 'archive', 'trash')),
    sender_name TEXT NOT NULL,
    sender_email TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    preview TEXT NOT NULL,
    body_text TEXT NOT NULL,
    body_html TEXT,
    raw_mime TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    is_starred INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    spf_dmarc_status TEXT NOT NULL DEFAULT 'PASS',
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mail_messages_mailbox ON mail_messages(mailbox_email, folder, received_at DESC);
