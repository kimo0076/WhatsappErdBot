-- ============================================
-- MAIN DATABASE — main.db
-- WhatsappErdBot v1.0
-- ============================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 1. Company Info (single row)
CREATE TABLE IF NOT EXISTS company_info (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    name        TEXT    NOT NULL,
    name_en     TEXT,
    phone       TEXT    NOT NULL UNIQUE,
    email       TEXT,
    address     TEXT,
    city        TEXT,
    country     TEXT    DEFAULT 'SA',
    currency    TEXT    DEFAULT 'SAR',
    symbol      TEXT    DEFAULT 'ر.س',
    language    TEXT    DEFAULT 'ar',
    timezone    TEXT    DEFAULT 'Asia/Riyadh',
    domain      TEXT    DEFAULT 'general',
    website     TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. System Settings (key-value)
CREATE TABLE IF NOT EXISTS system_settings (
    key         TEXT    PRIMARY KEY,
    value       TEXT    NOT NULL,
    description TEXT,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO system_settings (key, value, description) VALUES
    ('ai_enabled',              'true',   'Enable AI responses'),
    ('auto_confirm_orders',     'false',  'Auto confirm without supervisor'),
    ('low_stock_alert',         '10',     'Low stock threshold'),
    ('working_hours_start',     '09:00',  'Working hours start'),
    ('working_hours_end',       '22:00',  'Working hours end'),
    ('order_prefix',            'ORD',    'Order number prefix'),
    ('auto_cancel_hours',       '24',     'Auto cancel pending orders after N hours'),
    ('max_order_qty',           '100',    'Max quantity per order item');

-- 3. Supervisors
CREATE TABLE IF NOT EXISTS supervisors (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT    NOT NULL UNIQUE,
    name         TEXT    NOT NULL,
    role         TEXT    DEFAULT 'supervisor',
    permissions  TEXT    DEFAULT '["manage_orders","view_products","import_products"]',
    is_active    INTEGER DEFAULT 1,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4. Customers
CREATE TABLE IF NOT EXISTS customers (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number   TEXT    NOT NULL UNIQUE,
    whatsapp_jid   TEXT,
    name           TEXT,
    email          TEXT,
    address        TEXT,
    city           TEXT,
    country        TEXT,
    total_orders   INTEGER DEFAULT 0,
    total_spent    REAL    DEFAULT 0,
    status         TEXT    DEFAULT 'active',
    language       TEXT    DEFAULT 'ar',
    notes          TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_order_at  DATETIME
);

-- 5. Conversations
CREATE TABLE IF NOT EXISTS conversations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id      INTEGER NOT NULL,
    whatsapp_jid     TEXT    NOT NULL,
    session_id       TEXT    NOT NULL UNIQUE,
    status           TEXT    DEFAULT 'active',
    current_state    TEXT    DEFAULT 'idle',
    state_data       TEXT    DEFAULT '{}',
    last_intent      TEXT,
    started_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_message_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at         DATETIME,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

-- 6. Messages
CREATE TABLE IF NOT EXISTS messages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id  INTEGER NOT NULL,
    sender_type      TEXT    NOT NULL CHECK (sender_type IN ('customer', 'bot', 'supervisor')),
    message_text     TEXT    NOT NULL,
    message_type     TEXT    DEFAULT 'text',
    ai_response      TEXT,
    ai_intent        TEXT,
    ai_confidence    REAL,
    tokens_used      INTEGER DEFAULT 0,
    whatsapp_msg_id  TEXT,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- 7. Orders
CREATE TABLE IF NOT EXISTS orders (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number        TEXT    NOT NULL UNIQUE,
    customer_id         INTEGER NOT NULL,
    conversation_id     INTEGER,
    supervisor_id       INTEGER,
    status              TEXT    DEFAULT 'pending',
    substatus           TEXT,
    subtotal            REAL    DEFAULT 0,
    discount_amount     REAL    DEFAULT 0,
    tax_amount          REAL    DEFAULT 0,
    shipping_fee        REAL    DEFAULT 0,
    total_amount        REAL    DEFAULT 0,
    delivery_method     TEXT    DEFAULT 'delivery',
    delivery_address    TEXT,
    delivery_city       TEXT,
    delivery_lat        REAL,
    delivery_lng        REAL,
    delivery_phone      TEXT,
    delivery_time       TEXT,
    delivery_notes      TEXT,
    customer_message    TEXT,
    supervisor_notes    TEXT,
    notification_msg_id TEXT,
    extracted_by_ai     INTEGER DEFAULT 0,
    cancellation_reason TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    confirmed_at        DATETIME,
    delivered_at        DATETIME,
    cancelled_at        DATETIME,
    FOREIGN KEY (customer_id)     REFERENCES customers(id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (supervisor_id)   REFERENCES supervisors(id)
);

-- 8. Order Items
CREATE TABLE IF NOT EXISTS order_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id     INTEGER NOT NULL,
    product_id   INTEGER,
    product_name TEXT    NOT NULL,
    product_sku  TEXT,
    quantity     INTEGER NOT NULL,
    unit_price   REAL    NOT NULL,
    discount     REAL    DEFAULT 0,
    subtotal     REAL    NOT NULL,
    status       TEXT    DEFAULT 'pending',
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

-- 9. Payments
CREATE TABLE IF NOT EXISTS payments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id        INTEGER NOT NULL,
    method          TEXT    DEFAULT 'cod',
    amount          REAL    NOT NULL,
    status          TEXT    DEFAULT 'pending',
    transaction_id  TEXT,
    notes           TEXT,
    paid_at         DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id)
);

-- 10. Notifications
CREATE TABLE IF NOT EXISTS notifications (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_jid   TEXT    NOT NULL,
    recipient_type  TEXT    NOT NULL CHECK (recipient_type IN ('customer', 'supervisor')),
    type            TEXT    NOT NULL,
    message         TEXT    NOT NULL,
    status          TEXT    DEFAULT 'pending',
    related_type    TEXT,
    related_id      INTEGER,
    whatsapp_msg_id TEXT,
    sent_at         DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 11. Activity Log
CREATE TABLE IF NOT EXISTS activity_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    action      TEXT    NOT NULL,
    entity_type TEXT,
    entity_id   INTEGER,
    user_phone  TEXT,
    details     TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 12. Daily Sales Summary
CREATE TABLE IF NOT EXISTS daily_sales_summary (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    date             DATE    NOT NULL UNIQUE,
    total_orders     INTEGER DEFAULT 0,
    completed_orders INTEGER DEFAULT 0,
    cancelled_orders INTEGER DEFAULT 0,
    total_revenue    REAL    DEFAULT 0,
    total_items_sold INTEGER DEFAULT 0,
    avg_order_value  REAL    DEFAULT 0,
    top_product_id   INTEGER,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_customers_phone     ON customers(phone_number);
CREATE INDEX IF NOT EXISTS idx_conversations_cust  ON conversations(customer_id);
CREATE INDEX IF NOT EXISTS idx_conversations_jid   ON conversations(whatsapp_jid);
CREATE INDEX IF NOT EXISTS idx_conversations_state ON conversations(current_state);
CREATE INDEX IF NOT EXISTS idx_messages_conv       ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created    ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_customer     ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status       ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_number       ON orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_created      ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_order_items_order   ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_order      ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_notifications_recip ON notifications(recipient_jid);
CREATE INDEX IF NOT EXISTS idx_activity_action     ON activity_log(action);
CREATE INDEX IF NOT EXISTS idx_activity_created    ON activity_log(created_at);
