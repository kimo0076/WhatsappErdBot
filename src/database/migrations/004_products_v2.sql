-- ============================================
-- PRODUCTS DATABASE — v2 hardening
-- WhatsappErdBot
--
-- Idempotent additions:
--   * Indexes that match the new InventoryService access patterns
-- ============================================

PRAGMA foreign_keys = ON;

-- Helpful index for low-stock alerts and availability queries.
CREATE INDEX IF NOT EXISTS idx_products_stock
    ON products(is_available, stock_quantity);

-- Speeds up reverse lookups by order id when restocking on cancellation.
CREATE INDEX IF NOT EXISTS idx_inventory_reference
    ON inventory_transactions(reference_id);
