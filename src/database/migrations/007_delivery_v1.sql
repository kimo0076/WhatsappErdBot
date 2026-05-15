-- ============================================
-- MAIN DATABASE — v4 delivery agents
-- ============================================

CREATE TABLE IF NOT EXISTS delivery_agents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    phone       TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    vehicle     TEXT,
    notes       TEXT,
    is_active   INTEGER DEFAULT 1,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_delivery_agents_active ON delivery_agents(is_active);
