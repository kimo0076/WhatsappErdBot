-- ============================================
-- MAIN DATABASE — v2 hardening
-- WhatsappErdBot
--
-- This migration is additive and idempotent. It introduces:
--   * Idempotency keys to deduplicate WhatsApp message redeliveries
--   * Per-sender rate limit buckets
--   * Daily order sequence counter (race-free order numbers)
--   * AI conversation memory backed by SQLite (survives restarts)
--   * Wider activity_log with sender_role
--   * Helpful indexes for hot paths
-- ============================================

PRAGMA foreign_keys = ON;

-- 1. Idempotency keys for inbound WhatsApp messages.
--    Prevents double-processing when Baileys redelivers a message after
--    a restart or decryption retry.
CREATE TABLE IF NOT EXISTS idempotency_keys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT    NOT NULL UNIQUE,
    scope       TEXT    NOT NULL DEFAULT 'wa_message',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_idem_created ON idempotency_keys(created_at);

-- 2. Per-sender rate limit buckets (sliding window via row-per-event).
--    Enables a simple windowed counter without external dependencies.
CREATE TABLE IF NOT EXISTS rate_limit_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_key  TEXT    NOT NULL,
    bucket      TEXT    NOT NULL DEFAULT 'message',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rate_sender_time
    ON rate_limit_events(sender_key, bucket, created_at);

-- 3. Daily order sequence counter.
--    Eliminates the COUNT-based race in order number generation.
CREATE TABLE IF NOT EXISTS order_sequences (
    day         TEXT    PRIMARY KEY,            -- YYYYMMDD
    last_seq    INTEGER NOT NULL DEFAULT 0,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4. AI conversation memory.
--    Persists the rolling chat history per session so context survives restarts.
CREATE TABLE IF NOT EXISTS ai_memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT    NOT NULL,
    role        TEXT    NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content     TEXT    NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_memory_session
    ON ai_memory(session_id, created_at);

-- 5. Outbound message log (best-effort delivery audit).
CREATE TABLE IF NOT EXISTS outbound_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_jid   TEXT    NOT NULL,
    text            TEXT,
    status          TEXT    NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
    error           TEXT,
    whatsapp_msg_id TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_outbound_recipient
    ON outbound_log(recipient_jid, created_at);

-- 6. Backfill / extend activity_log indexes.
CREATE INDEX IF NOT EXISTS idx_activity_entity
    ON activity_log(entity_type, entity_id);

-- 7. Defaults for new system_settings keys (safe to re-run thanks to OR IGNORE).
INSERT OR IGNORE INTO system_settings (key, value, description) VALUES
    ('rate_limit_per_minute',   '20',   'Max inbound messages per sender per minute'),
    ('rate_limit_per_hour',     '200',  'Max inbound messages per sender per hour'),
    ('max_message_length',      '4000', 'Reject inbound text longer than this'),
    ('ai_history_max_messages', '20',   'Max past messages kept per AI session'),
    ('idempotency_ttl_hours',   '48',   'Hours to keep idempotency keys'),
    ('outbound_log_ttl_days',   '14',   'Days to keep outbound delivery log');
