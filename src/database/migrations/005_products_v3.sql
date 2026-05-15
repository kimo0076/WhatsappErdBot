-- ============================================
-- PRODUCTS DATABASE — v3 search support
-- ============================================

ALTER TABLE products ADD COLUMN name_ar TEXT;

CREATE INDEX IF NOT EXISTS idx_products_name_ar ON products(name_ar);
