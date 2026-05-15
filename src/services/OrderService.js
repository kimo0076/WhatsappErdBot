'use strict';

const db = require('../database/connection');
const config = require('../config/company.config');
const logger = require('../utils/logger');
const Inventory = require('./InventoryService');
const Customer = require('./CustomerService');
const {
  ORDER_STATUS,
  ORDER_ITEM_STATUS,
} = require('../utils/constants');

/**
 * OrderService
 * ------------
 * Owns the full lifecycle of an order. Every state transition is wrapped
 * in a `mdb.transaction()` so partial writes are impossible. Cross-DB
 * inventory changes are sequenced so that a failure on the products side
 * cleanly aborts the main-DB write.
 */
class OrderService {
  // ────────────────────────────────────────────────────────────────────
  // Order number generation
  // ────────────────────────────────────────────────────────────────────

  /**
   * Race-free order number using a per-day counter table. The whole
   * INSERT/UPDATE is run inside the same transaction as the order insert
   * so two concurrent calls cannot produce the same number.
   */
  _nextOrderNumber(mdb) {
    const prefix = config.orders?.orderPrefix || 'ORD';
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    mdb.prepare(`
      INSERT INTO order_sequences (day, last_seq) VALUES (?, 1)
        ON CONFLICT(day) DO UPDATE SET
          last_seq   = order_sequences.last_seq + 1,
          updated_at = CURRENT_TIMESTAMP
    `).run(day);

    const row = mdb.prepare(
      'SELECT last_seq FROM order_sequences WHERE day = ?'
    ).get(day);

    const seq = String(row.last_seq).padStart(3, '0');
    return `${prefix}-${day}-${seq}`;
  }

  // ────────────────────────────────────────────────────────────────────
  // Create
  // ────────────────────────────────────────────────────────────────────

  /**
   * Create an order with multi-item support.
   *
   * @param {object} params
   * @param {number} params.customerId
   * @param {string} params.customerPhone (for activity_log + sales)
   * @param {number} [params.conversationId]
   * @param {Array<OrderItemInput>} params.items
   * @param {string} [params.customerMessage]
   * @param {boolean} [params.backorder]   if true, all unavailable items will be allowed
   * @returns {{order: object, items: Array, deducted: Array}}
   *
   * Status rules:
   *   - normal flow                    -> 'pending'
   *   - any item is backorder=true     -> 'pending_supervisor_approval'
   *
   * Stock deduction:
   *   - normal items deduct immediately (committed sale).
   *   - backorder items DO NOT deduct (no stock to deduct).
   *
   * Throws on insufficient stock unless explicitly marked backorder.
   */
  create({ customerId, customerPhone, conversationId, items, customerMessage, backorder = false }) {
    if (!Array.isArray(items) || !items.length) {
      throw new Error('Order must contain at least one item');
    }

    const mdb = db.getMain();

    const normalized = items.map((it) => ({
      productId: it.productId || null,
      productName: (it.productName || '').trim(),
      productSku: it.productSku || null,
      quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
      unitPrice: parseFloat(it.unitPrice) || 0,
      discount: parseFloat(it.discount) || 0,
      backorder: !!it.backorder,
    })).filter((it) => it.productName);

    if (!normalized.length) throw new Error('Order has no valid items');

    for (const it of normalized) {
      it.subtotal = +(it.quantity * it.unitPrice - it.discount).toFixed(2);
    }
    const subtotal = +normalized.reduce((s, it) => s + it.subtotal, 0).toFixed(2);

    const isBackorder = backorder || normalized.some((it) => it.backorder);
    const orderStatus = isBackorder
      ? ORDER_STATUS.PENDING_APPROVAL
      : ORDER_STATUS.PENDING;

    // Phase 1: write order + items + customer bump in main DB transaction.
    const created = db.txMain(() => {
      const orderNumber = this._nextOrderNumber(mdb);

      const insertOrder = mdb.prepare(`
        INSERT INTO orders
          (order_number, customer_id, conversation_id, status,
           subtotal, total_amount, customer_message)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderNumber,
        customerId,
        conversationId || null,
        orderStatus,
        subtotal,
        subtotal,
        customerMessage || null,
      );
      const orderId = Number(insertOrder.lastInsertRowid);

      const insertItem = mdb.prepare(`
        INSERT INTO order_items
          (order_id, product_id, product_name, product_sku, quantity,
           unit_price, discount, subtotal, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const it of normalized) {
        insertItem.run(
          orderId,
          it.productId,
          it.productName,
          it.productSku,
          it.quantity,
          it.unitPrice,
          it.discount,
          it.subtotal,
          it.backorder ? ORDER_ITEM_STATUS.BACKORDER : ORDER_ITEM_STATUS.PENDING,
        );
      }

      Customer.bumpAfterOrder(customerId, subtotal);

      mdb.prepare(`
        INSERT INTO activity_log (action, entity_type, entity_id, user_phone, details)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        'order_created', 'order', orderId, customerPhone || null,
        JSON.stringify({
          orderNumber,
          items: normalized.map((i) => ({
            name: i.productName, qty: i.quantity, price: i.unitPrice,
          })),
          total: subtotal,
          backorder: isBackorder,
        }),
      );

      return { orderId, orderNumber };
    });

    // Phase 2: deduct stock for non-backorder items (separate DB).
    let deducted = [];
    const deductible = normalized.filter((it) => !it.backorder && it.productId);
    if (deductible.length) {
      try {
        deducted = Inventory.deductForOrder(deductible, {
          orderId: created.orderId,
          orderNumber: created.orderNumber,
          createdBy: customerPhone || null,
        });
      } catch (err) {
        // Compensate: cancel the order we just wrote so we don't leave zombies.
        logger.error(`Order ${created.orderNumber} stock deduction failed: ${err.message}`);
        try {
          this._cancelInternal(created.orderId, created.orderNumber, 'stock_failure', customerPhone);
        } catch (e) {
          logger.error(`Failed to cancel zombie order ${created.orderNumber}: ${e.message}`);
        }
        throw err;
      }
    }

    // Phase 3: record sales (analytical, best-effort).
    if (deductible.length) {
      Inventory.recordSales(
        deductible.map((it) => ({
          productId: it.productId,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          subtotal: it.subtotal,
        })),
        {
          orderId: created.orderId,
          orderNumber: created.orderNumber,
          customerPhone,
        },
      );
    }

    const order = mdb.prepare('SELECT * FROM orders WHERE id = ?').get(created.orderId);
    const orderItems = mdb.prepare(
      'SELECT * FROM order_items WHERE order_id = ?'
    ).all(created.orderId);

    return { order, items: orderItems, deducted };
  }

  // ────────────────────────────────────────────────────────────────────
  // Lookups
  // ────────────────────────────────────────────────────────────────────

  getByNumber(orderNumber) {
    return db.getMain().prepare(`
      SELECT o.*, c.phone_number, c.whatsapp_jid, c.name AS customer_name
        FROM orders o
        JOIN customers c ON o.customer_id = c.id
       WHERE o.order_number = ?
    `).get(orderNumber);
  }

  getItems(orderId) {
    return db.getMain().prepare(
      'SELECT * FROM order_items WHERE order_id = ? ORDER BY id'
    ).all(orderId);
  }

  listPending(limit = 20) {
    return db.getMain().prepare(`
      SELECT o.*, c.phone_number AS customer_phone, c.name AS customer_name
        FROM orders o
        JOIN customers c ON o.customer_id = c.id
       WHERE o.status IN (?, ?)
       ORDER BY o.created_at DESC
       LIMIT ?
    `).all(ORDER_STATUS.PENDING, ORDER_STATUS.PENDING_APPROVAL, limit);
  }

  listByCustomerPhone(phone, limit = 10) {
    return db.getMain().prepare(`
      SELECT o.*, c.phone_number
        FROM orders o
        JOIN customers c ON o.customer_id = c.id
       WHERE c.phone_number = ?
       ORDER BY o.created_at DESC
       LIMIT ?
    `).all(phone, limit);
  }

  getByNumberFlexible(input) {
    // Try exact match first
    let order = this.getByNumber(input.toUpperCase());
    if (order) return order;

    // Try reconstructing: "003-20260515" → "ORD-20260515-003"
    const prefix = (config.orders?.orderPrefix || 'ORD').toUpperCase();
    const m = input.match(/(\d{3})-(\d{8})/);
    if (m) {
      order = this.getByNumber(`${prefix}-${m[2]}-${m[1]}`);
      if (order) return order;
    }

    // Try with prefix added
    if (!input.toUpperCase().startsWith(prefix)) {
      order = this.getByNumber(`${prefix}-${input}`.toUpperCase());
      if (order) return order;
    }

    return null;
  }

  // ────────────────────────────────────────────────────────────────────
  // Transitions
  // ────────────────────────────────────────────────────────────────────

  approve(orderNumber, supervisorPhone) {
    const mdb = db.getMain();
    const order = this.getByNumber(orderNumber);
    if (!order) return { ok: false, reason: 'NOT_FOUND' };
    if (order.status === ORDER_STATUS.CANCELLED) return { ok: false, reason: 'CANCELLED' };
    if (order.status === ORDER_STATUS.COMPLETED) return { ok: false, reason: 'COMPLETED' };
    if (order.status === ORDER_STATUS.CONFIRMED || order.status === ORDER_STATUS.LOCATION_COLLECTED ||
        order.status === ORDER_STATUS.IN_TRANSIT || order.status === ORDER_STATUS.DELIVERED) {
      return { ok: false, reason: 'ALREADY_CONFIRMED' };
    }

    const wasBackorder = order.status === ORDER_STATUS.PENDING_APPROVAL;
    const items = this.getItems(order.id);

    db.txMain(() => {
      mdb.prepare(`
        UPDATE orders
           SET status        = ?,
               confirmed_at  = COALESCE(confirmed_at, CURRENT_TIMESTAMP),
               supervisor_id = (SELECT id FROM supervisors WHERE phone_number = ?)
         WHERE id = ?
      `).run(ORDER_STATUS.CONFIRMED, supervisorPhone, order.id);

      mdb.prepare(
        'UPDATE order_items SET status = ? WHERE order_id = ?'
      ).run(ORDER_ITEM_STATUS.CONFIRMED, order.id);

      mdb.prepare(`
        INSERT INTO activity_log (action, entity_type, entity_id, user_phone, details)
        VALUES (?, ?, ?, ?, ?)
      `).run('order_approved', 'order', order.id, supervisorPhone,
        JSON.stringify({ orderNumber, fromBackorder: wasBackorder }));
    });

    // If this was a backorder, deduct now (it wasn't deducted on create).
    let deducted = [];
    if (wasBackorder) {
      const deductible = items.filter((it) => it.product_id).map((it) => ({
        productId: it.product_id,
        quantity: it.quantity,
      }));
      if (deductible.length) {
        try {
          deducted = Inventory.deductForOrder(deductible, {
            orderId: order.id,
            orderNumber,
            createdBy: supervisorPhone,
          });
          Inventory.recordSales(
            items.filter((it) => it.product_id).map((it) => ({
              productId: it.product_id,
              quantity: it.quantity,
              unitPrice: it.unit_price,
              subtotal: it.subtotal,
            })),
            { orderId: order.id, orderNumber, customerPhone: order.phone_number },
          );
        } catch (err) {
          logger.warn(`Backorder ${orderNumber} approved but stock short: ${err.message}`);
          // Stock isn't actually available → revert to pending_supervisor_approval.
          mdb.prepare(`
            UPDATE orders SET status = ? WHERE id = ?
          `).run(ORDER_STATUS.PENDING_APPROVAL, order.id);
          return { ok: false, reason: 'OUT_OF_STOCK', detail: err };
        }
      }
    }

    return { ok: true, order: this.getByNumber(orderNumber), deducted };
  }

  reject(orderNumber, supervisorPhone, reason) {
    return this._cancelInternal(null, orderNumber, reason || 'rejected_by_supervisor', supervisorPhone, 'order_rejected');
  }

  cancel(orderNumber, actorPhone, reason) {
    return this._cancelInternal(null, orderNumber, reason || 'cancelled', actorPhone, 'order_cancelled');
  }

  _cancelInternal(orderIdOrNull, orderNumber, reason, actorPhone, actionLabel = 'order_cancelled') {
    const mdb = db.getMain();
    const order = orderIdOrNull
      ? mdb.prepare(`
          SELECT o.*, c.phone_number, c.whatsapp_jid
            FROM orders o JOIN customers c ON o.customer_id = c.id
           WHERE o.id = ?
        `).get(orderIdOrNull)
      : this.getByNumber(orderNumber);

    if (!order) return { ok: false, reason: 'NOT_FOUND' };
    if (order.status === ORDER_STATUS.CANCELLED) return { ok: false, reason: 'ALREADY_CANCELLED' };

    const items = this.getItems(order.id);

    // If we already deducted stock (any non-backorder/non-cancelled item), restock.
    const wasDeducted = order.status !== ORDER_STATUS.PENDING_APPROVAL;
    const restockable = wasDeducted
      ? items
        .filter((it) => it.product_id && it.status !== ORDER_ITEM_STATUS.BACKORDER && it.status !== ORDER_ITEM_STATUS.CANCELLED)
        .map((it) => ({ productId: it.product_id, quantity: it.quantity }))
      : [];

    db.txMain(() => {
      mdb.prepare(`
        UPDATE orders
           SET status = ?,
               cancellation_reason = ?,
               cancelled_at = CURRENT_TIMESTAMP,
               supervisor_id = COALESCE(supervisor_id, (SELECT id FROM supervisors WHERE phone_number = ?))
         WHERE id = ?
      `).run(ORDER_STATUS.CANCELLED, reason, actorPhone, order.id);

      mdb.prepare(
        'UPDATE order_items SET status = ? WHERE order_id = ?'
      ).run(ORDER_ITEM_STATUS.CANCELLED, order.id);

      mdb.prepare(`
        INSERT INTO activity_log (action, entity_type, entity_id, user_phone, details)
        VALUES (?, ?, ?, ?, ?)
      `).run(actionLabel, 'order', order.id, actorPhone,
        JSON.stringify({ orderNumber: order.order_number, reason }));
    });

    if (restockable.length) {
      try {
        Inventory.restockForOrder(restockable, {
          orderId: order.id,
          orderNumber: order.order_number,
          createdBy: actorPhone,
          notes: `cancel:${reason}`,
        });
      } catch (err) {
        logger.error(`Failed to restock ${order.order_number}: ${err.message}`);
      }
    }

    return { ok: true, order: this.getByNumber(order.order_number) };
  }

  markInTransit(orderNumber, actorPhone) {
    const order = this.getByNumber(orderNumber);
    if (!order) return { ok: false, reason: 'NOT_FOUND' };
    if (order.status === ORDER_STATUS.CANCELLED) return { ok: false, reason: 'CANCELLED' };
    if (order.status !== ORDER_STATUS.CONFIRMED && order.status !== ORDER_STATUS.LOCATION_COLLECTED) {
      return { ok: false, reason: 'INVALID_TRANSITION' };
    }

    db.txMain(() => {
      db.getMain().prepare(`
        UPDATE orders SET status = ? WHERE id = ?
      `).run(ORDER_STATUS.IN_TRANSIT, order.id);
      db.getMain().prepare(`
        INSERT INTO activity_log (action, entity_type, entity_id, user_phone, details)
        VALUES (?, ?, ?, ?, ?)
      `).run('order_in_transit', 'order', order.id, actorPhone,
        JSON.stringify({ orderNumber }));
    });
    return { ok: true, order: this.getByNumber(orderNumber) };
  }

  complete(orderNumber, actorPhone) {
    const order = this.getByNumber(orderNumber);
    if (!order) return { ok: false, reason: 'NOT_FOUND' };
    if (order.status === ORDER_STATUS.CANCELLED) return { ok: false, reason: 'CANCELLED' };
    if (order.status !== ORDER_STATUS.IN_TRANSIT && order.status !== ORDER_STATUS.DELIVERED) {
      return { ok: false, reason: 'INVALID_TRANSITION' };
    }

    db.txMain(() => {
      db.getMain().prepare(`
        UPDATE orders
           SET status = ?, delivered_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `).run(ORDER_STATUS.COMPLETED, order.id);
      db.getMain().prepare(
        'UPDATE order_items SET status = ? WHERE order_id = ?'
      ).run(ORDER_ITEM_STATUS.DELIVERED, order.id);
      db.getMain().prepare(`
        INSERT INTO activity_log (action, entity_type, entity_id, user_phone, details)
        VALUES (?, ?, ?, ?, ?)
      `).run('order_completed', 'order', order.id, actorPhone,
        JSON.stringify({ orderNumber }));
    });
    return { ok: true, order: this.getByNumber(orderNumber) };
  }

  assignDelivery(orderNumber, actorPhone, deliveryPhone, notes) {
    const order = this.getByNumber(orderNumber);
    if (!order) return { ok: false, reason: 'NOT_FOUND' };
    if (order.status === ORDER_STATUS.CANCELLED) return { ok: false, reason: 'CANCELLED' };
    if (order.status !== ORDER_STATUS.CONFIRMED && order.status !== ORDER_STATUS.LOCATION_COLLECTED) {
      return { ok: false, reason: 'INVALID_TRANSITION' };
    }

    db.txMain(() => {
      db.getMain().prepare(`
        UPDATE orders
           SET delivery_phone = ?, delivery_notes = ?
         WHERE id = ?
      `).run(deliveryPhone, notes || null, order.id);
      db.getMain().prepare(`
        INSERT INTO activity_log (action, entity_type, entity_id, user_phone, details)
        VALUES (?, ?, ?, ?, ?)
      `).run('order_assigned', 'order', order.id, actorPhone,
        JSON.stringify({ orderNumber, deliveryPhone, notes: notes || null }));
    });
    return { ok: true, order: this.getByNumber(orderNumber) };
  }

  attachLocation(orderId, location, actorPhone) {
    const mdb = db.getMain();
    const order = mdb.prepare(
      'SELECT id, status, order_number FROM orders WHERE id = ?'
    ).get(orderId);
    if (!order) return { ok: false, reason: 'NOT_FOUND' };

    const next = order.status === ORDER_STATUS.PENDING_APPROVAL
      ? order.status
      : ORDER_STATUS.LOCATION_COLLECTED;

    db.txMain(() => {
      mdb.prepare(`
        UPDATE orders
           SET delivery_lat     = ?,
               delivery_lng     = ?,
               delivery_address = ?,
               status           = ?
         WHERE id = ?
      `).run(
        location.latitude || null,
        location.longitude || null,
        location.address || null,
        next,
        orderId,
      );
      mdb.prepare(`
        INSERT INTO activity_log (action, entity_type, entity_id, user_phone, details)
        VALUES (?, ?, ?, ?, ?)
      `).run('location_received', 'order', orderId, actorPhone || null,
        JSON.stringify({ orderNumber: order.order_number, ...location }));
    });

    return { ok: true };
  }

  // ────────────────────────────────────────────────────────────────────
  // Maintenance
  // ────────────────────────────────────────────────────────────────────

  autoCancelStale(hours) {
    const stale = db.getMain().prepare(`
      SELECT id, order_number FROM orders
       WHERE status IN (?, ?, ?)
         AND created_at < datetime('now', '-' || ? || ' hours')
    `).all(
      ORDER_STATUS.PENDING,
      ORDER_STATUS.PENDING_APPROVAL,
      ORDER_STATUS.LOCATION_COLLECTED,
      hours,
    );

    let count = 0;
    for (const row of stale) {
      const r = this._cancelInternal(row.id, row.order_number,
        `auto-cancel after ${hours}h`, 'system', 'order_auto_cancelled');
      if (r.ok) count++;
    }
    return count;
  }
}

// Singleton: a single OrderService coordinates all order writes.
module.exports = new OrderService();
