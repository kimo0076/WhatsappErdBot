-- ============================================
-- MAIN DATABASE — v3 bug fixes
-- ============================================

-- Fix auto_approve_orders key (was seeded as auto_confirm_orders)
INSERT OR IGNORE INTO system_settings (key, value, description)
VALUES ('auto_approve_orders', 'false', 'Auto-approve orders without supervisor review');

-- Add AI memory TTL setting
INSERT OR IGNORE INTO system_settings (key, value, description)
VALUES ('ai_memory_ttl_hours', '72', 'Hours to keep AI conversation memory');
