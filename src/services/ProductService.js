'use strict';

const db = require('../database/connection');

/**
 * Read-only catalog accessor. Writes go through InventoryService and
 * the import flow.
 */
class ProductService {
  search(query) {
    const pdb = db.getProducts();
    const like = `%${query}%`;
    return pdb.prepare(`
      SELECT p.*, c.name AS category_name
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.is_available = 1
         AND p.stock_quantity > 0
         AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode = ? OR p.description LIKE ?)
       ORDER BY p.total_sold DESC, p.name ASC
       LIMIT 5
    `).all(like, like, query, like);
  }

  searchAll(query) {
    const pdb = db.getProducts();
    const like = `%${query}%`;
    return pdb.prepare(`
      SELECT p.*, c.name AS category_name
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
       WHERE (p.name LIKE ? OR p.sku LIKE ? OR p.barcode = ? OR p.description LIKE ?)
       ORDER BY p.is_available DESC,
                CASE WHEN p.stock_quantity > 0 THEN 0 ELSE 1 END,
                p.total_sold DESC,
                p.name ASC
       LIMIT 5
    `).all(like, like, query, like);
  }

  /**
   * Best single match for a fuzzy product name. Returns null when no match
   * is found at all. Used when extracting orders from natural language.
   */
  bestMatch(query) {
    const results = this.searchAll(query);
    return results[0] || null;
  }

  getAllAvailable() {
    return db.getProducts().prepare(`
      SELECT p.*, c.name AS category_name
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.is_available = 1 AND p.stock_quantity > 0
       ORDER BY c.sort_order, p.name
    `).all();
  }

  getById(id) {
    return db.getProducts().prepare(`
      SELECT p.*, c.name AS category_name
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.id = ?
    `).get(id);
  }

  getByCategory(categoryName) {
    const like = `%${categoryName}%`;
    return db.getProducts().prepare(`
      SELECT p.*, c.name AS category_name
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.is_available = 1 AND p.stock_quantity > 0
         AND (c.name LIKE ? OR c.name_en LIKE ?)
       ORDER BY p.total_sold DESC
       LIMIT 10
    `).all(like, like);
  }

  getAllCategories() {
    return db.getProducts().prepare(`
      SELECT id, name, name_en, description
        FROM categories
       WHERE is_active = 1 AND id != 1
       ORDER BY sort_order, name
    `).all();
  }

  checkAvailability(productId, quantity) {
    const product = this.getById(productId);
    if (!product) return { ok: false, reason: 'المنتج غير موجود' };
    if (!product.is_available) return { ok: false, reason: 'المنتج غير متوفر حالياً' };
    if (product.stock_quantity < quantity) {
      return {
        ok: false,
        reason: `الكمية المتاحة ${product.stock_quantity} ${product.unit || 'قطعة'} فقط`,
        available: product.stock_quantity,
      };
    }
    return { ok: true, product };
  }

  getTopSelling(limit = 5) {
    return db.getProducts().prepare(`
      SELECT * FROM products WHERE total_sold > 0
       ORDER BY total_sold DESC LIMIT ?
    `).all(limit);
  }
}

module.exports = new ProductService();
