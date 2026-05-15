'use strict';

const db = require('../database/connection');
const logger = require('../utils/logger');

/**
 * Robust CSV parser. Handles quoted fields, escaped quotes ("") and CRLF.
 * Returns an array of objects keyed by lower-cased headers, falling back
 * to numeric indices for headerless data.
 */
function parseCSV(rawText) {
  const text = rawText.replace(/\r\n?/g, '\n').replace(/\\n/g, '\n').trim();
  if (!text) return [];
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(cell.trim()); cell = ''; continue; }
    if (ch === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  row.push(cell.trim());
  if (row.length > 1 || row[0]) rows.push(row);

  if (!rows.length) return [];

  const headers = rows[0].map((h) => h.toLowerCase());
  const looksLikeHeader = /[a-zA-Z\u0600-\u06FF]/.test(headers.join(''));

  const dataRows = looksLikeHeader ? rows.slice(1) : rows;
  return dataRows
    .filter((r) => r.some((v) => v))
    .map((r) => {
      const obj = {};
      for (let i = 0; i < r.length; i++) {
        if (looksLikeHeader && headers[i]) obj[headers[i]] = r[i];
        obj[i] = r[i];
      }
      return obj;
    });
}

/**
 * Import / upsert products from a CSV-shaped array.
 * Recognized columns (case-insensitive):
 *   name, price, category, stock, unit, description, sku, barcode
 *
 * The whole batch is wrapped in a single transaction; partial failures
 * are rolled back to keep the catalog consistent.
 */
function importProducts(records, { actor } = {}) {
  if (!Array.isArray(records) || !records.length) {
    return { imported: 0, updated: 0, skipped: 0 };
  }

  const pdb = db.getProducts();
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  const findCat = pdb.prepare(
    'SELECT id FROM categories WHERE name = ? OR name_en = ?'
  );
  const insertCat = pdb.prepare(
    'INSERT INTO categories (name, is_active) VALUES (?, 1)'
  );
  const findProductByName = pdb.prepare(
    'SELECT id FROM products WHERE name = ?'
  );
  const findProductBySku = pdb.prepare(
    'SELECT id FROM products WHERE sku = ?'
  );
  const insertProduct = pdb.prepare(`
    INSERT INTO products
      (sku, category_id, name, price, description, stock_quantity, unit, is_available, barcode)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  const updateProduct = pdb.prepare(`
    UPDATE products
       SET price = ?, description = ?, stock_quantity = ?, unit = ?,
           is_available = 1, barcode = COALESCE(?, barcode), updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `);

  const tx = pdb.transaction(() => {
    for (const raw of records) {
      const name = String(raw.name || raw[0] || '').trim();
      if (!name) { skipped++; continue; }

      const catName = String(raw.category || raw[2] || 'عام').trim() || 'عام';
      let catRow = findCat.get(catName, catName);
      if (!catRow) {
        const r = insertCat.run(catName);
        catRow = { id: r.lastInsertRowid };
      }

      const price = parseFloat(raw.price ?? raw[1]) || 0;
      const stock = parseInt(raw.stock ?? raw[3], 10) || 0;
      const unit = String(raw.unit || raw[4] || 'قطعة').trim() || 'قطعة';
      const desc = String(raw.description || raw[5] || '').trim();
      const sku = raw.sku ? String(raw.sku).trim() : null;
      const barcode = raw.barcode ? String(raw.barcode).trim() : null;

      let existing = null;
      if (sku) existing = findProductBySku.get(sku);
      if (!existing) existing = findProductByName.get(name);

      if (existing) {
        updateProduct.run(price, desc, stock, unit, barcode, existing.id);
        updated++;
      } else {
        insertProduct.run(sku, catRow.id, name, price, desc, stock, unit, barcode);
        imported++;
      }
    }
  });

  try {
    tx();
  } catch (err) {
    logger.error(`Import transaction failed: ${err.message}`);
    throw err;
  }

  // Audit row.
  try {
    pdb.prepare(`
      INSERT INTO import_history
        (file_name, file_type, total_rows, imported_rows, failed_rows, status, ai_processed, imported_by, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      'inline-or-upload',
      'csv',
      records.length,
      imported + updated,
      skipped,
      'completed',
      0,
      actor || null,
    );
  } catch (e) {
    logger.warn('import_history write failed: ' + e.message);
  }

  return { imported, updated, skipped };
}

module.exports = { parseCSV, importProducts };
