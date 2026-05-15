'use strict';

const db = require('../database/connection');
const logger = require('../utils/logger');
const { INVENTORY_REASON } = require('../utils/constants');

/**
 * InventoryService
 * ----------------
 * Owns every change to `products.stock_quantity` so that:
 *   1) every change is paired with an inventory_transactions row,
 *   2) all changes within an order happen in a single transaction,
 *   3) callers cannot accidentally drive stock negative.
 *
 * NOTE: the products DB and the main DB are separate SQLite files, so we
 * cannot put both inside one BEGIN. Each service therefore exposes a
 * synchronous transactional method that wraps its own DB writes; callers
 * orchestrate cross-DB consistency by writing in a safe order:
 *
 *   1. main: insert order + items (rolled back on stock failure)
 *   2. products: deduct stock (throws if any item fails)
 *   3. main: commit
 *
 * If step 2 throws, step 1's transaction is rolled back, leaving both
 * databases consistent. If step 3 fails after step 2 succeeded (extremely
 * rare with local SQLite), we restock via `restockForOrder` to compensate.
 */
class InventoryService {
  /**
   * Atomically deduct stock for a list of items.
   *
   * @param {Array<{productId:number, quantity:number, productName?:string}>} items
   * @param {{ orderId:number, orderNumber:string, createdBy:string }} ctx
   * @returns {Array<{productId:number, deducted:number, remaining:number}>}
   * @throws Error('OUT_OF_STOCK:<productId>') if any item is short.
   */
  deductForOrder(items, ctx) {
    const pdb = db.getProducts();

    const tx = pdb.transaction(() => {
      const out = [];

      for (const item of items) {
        if (!item.productId) continue; // free-text/backorder line: skip

        const product = pdb.prepare(
          'SELECT id, name, stock_quantity FROM products WHERE id = ?'
        ).get(item.productId);

        if (!product) {
          const err = new Error(`PRODUCT_NOT_FOUND:${item.productId}`);
          err.code = 'PRODUCT_NOT_FOUND';
          err.productId = item.productId;
          throw err;
        }

        if (product.stock_quantity < item.quantity) {
          const err = new Error(`OUT_OF_STOCK:${item.productId}`);
          err.code = 'OUT_OF_STOCK';
          err.productId = item.productId;
          err.productName = product.name;
          err.requested = item.quantity;
          err.available = product.stock_quantity;
          throw err;
        }

        const previous = product.stock_quantity;
        const newQty = previous - item.quantity;

        pdb.prepare(`
          UPDATE products
             SET stock_quantity = ?,
                 total_sold     = COALESCE(total_sold, 0) + ?,
                 last_sold_at   = CURRENT_TIMESTAMP,
                 updated_at     = CURRENT_TIMESTAMP
           WHERE id = ?
        `).run(newQty, item.quantity, item.productId);

        pdb.prepare(`
          INSERT INTO inventory_transactions
            (product_id, transaction_type, quantity, previous_qty, new_qty,
             reason, reference_id, notes, created_by)
          VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.productId,
          item.quantity,
          previous,
          newQty,
          INVENTORY_REASON.SALE,
          ctx.orderId,
          `order:${ctx.orderNumber}`,
          ctx.createdBy || null,
        );

        out.push({
          productId: item.productId,
          deducted: item.quantity,
          remaining: newQty,
        });
      }

      return out;
    });

    return tx();
  }

  /**
   * Restock items that were previously deducted (compensation on cancel).
   */
  restockForOrder(items, ctx) {
    const pdb = db.getProducts();

    const tx = pdb.transaction(() => {
      const out = [];

      for (const item of items) {
        if (!item.productId) continue;

        const product = pdb.prepare(
          'SELECT id, stock_quantity, total_sold FROM products WHERE id = ?'
        ).get(item.productId);
        if (!product) continue;

        const previous = product.stock_quantity;
        const newQty = previous + item.quantity;
        const newTotalSold = Math.max(0, (product.total_sold || 0) - item.quantity);

        pdb.prepare(`
          UPDATE products
             SET stock_quantity = ?,
                 total_sold     = ?,
                 updated_at     = CURRENT_TIMESTAMP
           WHERE id = ?
        `).run(newQty, newTotalSold, item.productId);

        pdb.prepare(`
          INSERT INTO inventory_transactions
            (product_id, transaction_type, quantity, previous_qty, new_qty,
             reason, reference_id, notes, created_by)
          VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.productId,
          item.quantity,
          previous,
          newQty,
          INVENTORY_REASON.CANCEL_ORDER,
          ctx.orderId,
          ctx.notes || `cancel:${ctx.orderNumber || ''}`,
          ctx.createdBy || null,
        );

        out.push({ productId: item.productId, restocked: item.quantity, remaining: newQty });
      }

      return out;
    });

    return tx();
  }

  /**
   * Manual stock adjustment (supervisor sets a target stock).
   */
  setStock(productId, newQty, ctx = {}) {
    if (newQty < 0) throw new Error('Stock cannot be negative');
    const pdb = db.getProducts();

    const tx = pdb.transaction(() => {
      const product = pdb.prepare(
        'SELECT id, stock_quantity FROM products WHERE id = ?'
      ).get(productId);
      if (!product) throw new Error('Product not found');

      const previous = product.stock_quantity;
      const delta = newQty - previous;

      pdb.prepare(
        'UPDATE products SET stock_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(newQty, productId);

      pdb.prepare(`
        INSERT INTO inventory_transactions
          (product_id, transaction_type, quantity, previous_qty, new_qty,
           reason, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        productId,
        delta >= 0 ? 'in' : 'out',
        Math.abs(delta),
        previous,
        newQty,
        INVENTORY_REASON.ADJUSTMENT,
        ctx.notes || null,
        ctx.createdBy || null,
      );

      return { previous, newQty, delta };
    });

    return tx();
  }

  /**
   * Record per-product sales for analytics. Done after the main DB has
   * committed so that we have a confirmed orderId.
   */
  recordSales(items, ctx) {
    const pdb = db.getProducts();
    const tx = pdb.transaction(() => {
      const stmt = pdb.prepare(`
        INSERT INTO sales_records
          (product_id, order_id, order_number, quantity_sold, unit_price,
           total_amount, customer_phone)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        if (!item.productId) continue;
        stmt.run(
          item.productId,
          ctx.orderId,
          ctx.orderNumber,
          item.quantity,
          item.unitPrice,
          item.subtotal,
          ctx.customerPhone || null,
        );
      }
    });
    try { tx(); } catch (err) { logger.warn('recordSales failed: ' + err.message); }
  }
}

module.exports = new InventoryService();
