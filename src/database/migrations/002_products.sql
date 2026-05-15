-- ============================================
-- PRODUCTS DATABASE — products.db
-- WhatsappErdBot v1.0
-- ============================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 1. Categories
CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    name_en     TEXT,
    description TEXT,
    parent_id   INTEGER,
    sort_order  INTEGER DEFAULT 0,
    is_active   INTEGER DEFAULT 1,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES categories(id)
);

INSERT OR IGNORE INTO categories (id, name, name_en) VALUES (1, 'عام', 'General');

-- 2. Products
CREATE TABLE IF NOT EXISTS products (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    sku              TEXT    UNIQUE,
    name             TEXT    NOT NULL,
    name_en          TEXT,
    description      TEXT,
    category_id      INTEGER DEFAULT 1,
    price            REAL    NOT NULL DEFAULT 0,
    cost             REAL    DEFAULT 0,
    discount_price   REAL,
    stock_quantity   INTEGER DEFAULT 0,
    min_stock_level  INTEGER DEFAULT 5,
    unit             TEXT    DEFAULT 'قطعة',
    is_available     INTEGER DEFAULT 1,
    is_featured      INTEGER DEFAULT 0,
    barcode          TEXT,
    brand            TEXT,
    weight           REAL,
    total_sold       INTEGER DEFAULT 0,
    total_revenue    REAL    DEFAULT 0,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_sold_at     DATETIME,
    FOREIGN KEY (category_id) REFERENCES categories(id)
);

-- 3. Inventory Transactions
CREATE TABLE IF NOT EXISTS inventory_transactions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id       INTEGER NOT NULL,
    transaction_type TEXT    NOT NULL CHECK (transaction_type IN ('in', 'out', 'adjustment')),
    quantity         INTEGER NOT NULL,
    previous_qty     INTEGER NOT NULL DEFAULT 0,
    new_qty          INTEGER NOT NULL DEFAULT 0,
    reason           TEXT    CHECK (reason IN ('purchase', 'sale', 'return', 'damaged', 'adjustment', 'initial', 'cancel_order')),
    reference_id     INTEGER,
    notes            TEXT,
    created_by       TEXT,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id)
);

-- 4. Sales Records
CREATE TABLE IF NOT EXISTS sales_records (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id      INTEGER NOT NULL,
    order_id        INTEGER NOT NULL,
    order_number    TEXT    NOT NULL,
    quantity_sold   INTEGER NOT NULL,
    unit_price      REAL    NOT NULL,
    total_amount    REAL    NOT NULL,
    profit_amount   REAL    DEFAULT 0,
    customer_phone  TEXT,
    sold_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id)
);

-- 5. Import History
CREATE TABLE IF NOT EXISTS import_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name      TEXT    NOT NULL,
    file_type      TEXT,
    file_size      INTEGER,
    total_rows     INTEGER DEFAULT 0,
    imported_rows  INTEGER DEFAULT 0,
    failed_rows    INTEGER DEFAULT 0,
    status         TEXT    DEFAULT 'processing',
    error_log      TEXT,
    ai_processed   INTEGER DEFAULT 1,
    imported_by    TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at   DATETIME
);

-- 6. Pricing Rules
CREATE TABLE IF NOT EXISTS pricing_rules (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    rule_type       TEXT,
    conditions      TEXT,
    discount_type   TEXT    CHECK (discount_type IN ('percentage', 'fixed')),
    discount_value  REAL    NOT NULL DEFAULT 0,
    start_date      DATE,
    end_date        DATE,
    is_active       INTEGER DEFAULT 1,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_products_sku       ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_category  ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_name      ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_avail     ON products(is_available);
CREATE INDEX IF NOT EXISTS idx_inventory_product  ON inventory_transactions(product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_type     ON inventory_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_sales_product      ON sales_records(product_id);
CREATE INDEX IF NOT EXISTS idx_sales_order        ON sales_records(order_id);
CREATE INDEX IF NOT EXISTS idx_sales_date         ON sales_records(sold_at);
