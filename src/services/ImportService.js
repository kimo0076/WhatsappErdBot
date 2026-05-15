'use strict';

const db = require('../database/connection');
const logger = require('../utils/logger');
const AI = require('../ai/AIService');

const COLUMN_MAP = {
  // English
  name: 'name', product: 'name', productname: 'name', product_name: 'name',
  price: 'price', cost: 'price', price_sar: 'price',
  category: 'category', cat: 'category', section: 'category', department: 'category',
  stock: 'stock', quantity: 'stock', qty: 'stock', count: 'stock', quantity_available: 'stock',
  unit: 'unit', uom: 'unit', unit_of_measure: 'unit',
  description: 'description', desc: 'description', details: 'description',
  sku: 'sku', code: 'sku', product_code: 'sku',
  barcode: 'barcode', ean: 'barcode', upc: 'barcode',
  name_ar: 'name_ar', namear: 'name_ar', arabic_name: 'name_ar',
  // Arabic
  'الاسم': 'name', 'اسم': 'name', 'المنتج': 'name', 'اسم المنتج': 'name',
  'السعر': 'price', 'سعر': 'price', 'التكلفة': 'price',
  'الفئة': 'category', 'القسم': 'category', 'التصنيف': 'category', 'الصنف': 'category',
  'الكمية': 'stock', 'العدد': 'stock', 'المخزون': 'stock', 'كمية': 'stock', 'عدد': 'stock',
  'الوحدة': 'unit', 'وحدة': 'unit', 'وحدة القياس': 'unit',
  'الوصف': 'description', 'وصف': 'description', 'تفاصيل': 'description',
  'الكود': 'sku', 'رمز': 'sku', 'رمز المنتج': 'sku',
  'باركود': 'barcode', 'الباركود': 'barcode',
  'الاسم_عربي': 'name_ar', 'الاسم العربي': 'name_ar', 'اسم عربي': 'name_ar',
};

// ── Format Detection ───────────────────────────────────────────────────

function detectFormat(text) {
  const firstLine = text.trim().split('\n')[0];
  if (!firstLine) return 'empty';

  const commas = (firstLine.match(/,/g) || []).length;
  const tabs = (firstLine.match(/\t/g) || []).length;
  const pipes = (firstLine.match(/\|/g) || []).length;
  const semicolons = (firstLine.match(/;/g) || []).length;

  const max = Math.max(commas, tabs, pipes, semicolons);
  if (max < 1) return 'natural';
  if (max === tabs) return 'tsv';
  if (max === pipes) return 'pipe';
  if (max === semicolons) return 'semicolon';
  return 'csv';
}

function getDelimiter(format) {
  switch (format) {
  case 'tsv': return '\t';
  case 'pipe': return '|';
  case 'semicolon': return ';';
  default: return ',';
  }
}

// ── Parsing ────────────────────────────────────────────────────────────

function parseDelimited(rawText, delimiter) {
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
    if (ch === delimiter) { row.push(cell.trim()); cell = ''; continue; }
    if (ch === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  row.push(cell.trim());
  if (row.length > 1 || row[0]) rows.push(row);

  if (!rows.length) return [];

  const headers = rows[0].map((h) => h.toLowerCase().trim());
  const hasLetters = /[a-zA-Z\u0600-\u06FF]/.test(headers.join(''));
  const digitFields = headers.filter((h) => /\d/.test(h)).length;
  // Only treat as header if: 2+ rows, has text, and most fields are NOT numbers
  const looksLikeHeader = rows.length > 1 && hasLetters && digitFields < headers.length / 2;
  const dataRows = looksLikeHeader ? rows.slice(1) : rows;
  return { headers: looksLikeHeader ? headers : null, dataRows };
}

function mapRow(values, headers) {
  const record = { _raw: values };
  record.name = '';
  record.price = 0;
  record.stock = 0;
  record.unit = 'قطعة';
  record.category = 'عام';

  if (headers) {
    for (let i = 0; i < headers.length; i++) {
      const key = COLUMN_MAP[headers[i]];
      if (key && values[i]) {
        record[key] = values[i].trim();
      }
    }
  }

  // Positional fallback
  if (!record.name && values[0]) record.name = values[0].trim();
  if (!record.price && values[1]) record.price = parseFloat(values[1]) || 0;
  if (!record.category && values[2]) record.category = values[2].trim() || 'عام';
  if (!record.stock && values[3]) record.stock = parseInt(values[3], 10) || 0;
  if (values[4] && !record.unit) record.unit = values[4].trim() || 'قطعة';
  if (values[5] && !record.description) record.description = values[5].trim();
  if (values[6] && !record.sku) record.sku = values[6].trim();
  if (values[7] && !record.barcode) record.barcode = values[7].trim();

  // Normalize
  record.name = record.name.trim();
  if (typeof record.price === 'string') record.price = parseFloat(record.price) || 0;
  if (typeof record.stock === 'string') record.stock = parseInt(record.stock, 10) || 0;

  return record;
}

function parseCSV(text) {
  const format = detectFormat(text);
  if (format === 'empty') return [];

  if (format === 'natural') {
    return text.trim().split('\n')
      .filter((l) => l.trim())
      .map((line) => ({ name: line.trim(), price: 0, stock: 0, unit: 'قطعة', category: 'عام' }));
  }

  const delimiter = getDelimiter(format);
  const parsed = parseDelimited(text, delimiter);
  if (!parsed || !parsed.dataRows.length) return [];

  return parsed.dataRows
    .filter((r) => r.some((v) => v))
    .map((values) => mapRow(values, parsed.headers));
}

// ── AI Parsing ─────────────────────────────────────────────────────────

async function parseWithAI(text) {
  try {
    const result = await AI.askJSON(
      `Extract product list from this text. Return ONLY a JSON array of objects.
Each object: { "name": "", "name_ar": "", "price": 0, "category": "", "stock": 0, "unit": "قطعة", "description": "", "sku": "", "barcode": "" }
If a field is absent use the default value. Detect column headers if present.
Arabic column names: الاسم=name, السعر=price, الفئة=category, الكمية=stock, الوحدة=unit, الوصف=description`,
      text.substring(0, 4000),
      { maxTokens: 3000, temperature: 0.1, maxRetriesOverride: 2 }
    );
    return Array.isArray(result) ? result : null;
  } catch (err) {
    logger.warn(`AI parse failed: ${err.message}`);
    return null;
  }
}

// ── Validation ─────────────────────────────────────────────────────────

function validateRecord(record, rowIndex) {
  const warnings = [];

  if (!record.name) {
    warnings.push({ row: rowIndex + 1, field: 'name', severity: 'error', message: 'اسم المنتج مفقود' });
    return { valid: false, warnings };
  }

  if (!record.price || record.price <= 0) {
    warnings.push({ row: rowIndex + 1, field: 'price', severity: 'warn', message: `"${record.name}": السعر غير محدد — تم تعيينه إلى 0` });
  }
  if (record.price > 100000) {
    warnings.push({ row: rowIndex + 1, field: 'price', severity: 'warn', message: `"${record.name}": السعر مرتفع (${record.price}) — تأكد` });
  }
  if (!record.stock || record.stock <= 0) {
    warnings.push({ row: rowIndex + 1, field: 'stock', severity: 'warn', message: `"${record.name}": الكمية غير محددة — تم تعيينها إلى 0` });
  }
  if (record.stock < 0) {
    warnings.push({ row: rowIndex + 1, field: 'stock', severity: 'warn', message: `"${record.name}": كمية سالبة — تم تعيينها إلى 0` });
    record.stock = 0;
  }

  return { valid: true, warnings };
}

// ── Report ─────────────────────────────────────────────────────────────

function generateReport(result) {
  const lines = ['✅ *تقرير الاستيراد*', ''];
  lines.push(`📦 أُضيف: ${result.imported} | 🔄 حُدث: ${result.updated} | ⏭️ تُخطي: ${result.skipped}`);

  const errors = result.warnings.filter((w) => w.severity === 'error');
  const warns = result.warnings.filter((w) => w.severity === 'warn');

  if (errors.length) {
    lines.push('');
    lines.push('❌ *أخطاء:*');
    errors.forEach((e) => lines.push(`  • ${e.message}`));
  }

  if (warns.length) {
    lines.push('');
    lines.push('⚠️ *تحذيرات:*');
    warns.slice(0, 8).forEach((w) => lines.push(`  • ${w.message}`));
    if (warns.length > 8) lines.push(`  ... و ${warns.length - 8} تحذيرات أخرى`);
  }

  lines.push('');
  lines.push('اكتب *مخزون* لعرض المخزون.');
  return lines.join('\n');
}

// ── Import ─────────────────────────────────────────────────────────────

function importProducts(records, { actor } = {}) {
  if (!Array.isArray(records) || !records.length) {
    return { imported: 0, updated: 0, skipped: 0, warnings: [] };
  }

  const pdb = db.getProducts();
  const allWarnings = [];
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  const validated = [];
  for (let i = 0; i < records.length; i++) {
    const { valid, warnings } = validateRecord(records[i], i);
    allWarnings.push(...warnings);
    if (!valid) { skipped++; continue; }
    validated.push(records[i]);
  }

  if (!validated.length) {
    return { imported: 0, updated: 0, skipped, warnings: allWarnings };
  }

  const findCat = pdb.prepare('SELECT id FROM categories WHERE name = ? OR name_en = ?');
  const insertCat = pdb.prepare('INSERT INTO categories (name, is_active) VALUES (?, 1)');
  const findProductByName = pdb.prepare('SELECT id FROM products WHERE name = ?');
  const findProductBySku = pdb.prepare('SELECT id FROM products WHERE sku = ?');
  const insertProduct = pdb.prepare(`
    INSERT INTO products
      (sku, category_id, name, name_ar, price, description, stock_quantity, unit, is_available, barcode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  const updateProduct = pdb.prepare(`
    UPDATE products
       SET price = ?, description = ?, stock_quantity = ?, unit = ?,
           name_ar = COALESCE(?, name_ar),
           is_available = 1, barcode = COALESCE(?, barcode), updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `);

  try {
    pdb.transaction(() => {
      for (const record of validated) {
        const name = record.name.trim();
        const catName = record.category || 'عام';
        let catRow = findCat.get(catName, catName);
        if (!catRow) {
          const r = insertCat.run(catName);
          catRow = { id: r.lastInsertRowid };
        }

        const price = Number(record.price) || 0;
        const stock = parseInt(record.stock, 10) || 0;
        const unit = record.unit || 'قطعة';
        const desc = record.description || '';
        const nameAr = record.name_ar || null;
        const sku = record.sku || null;
        const barcode = record.barcode || null;

        let existing = null;
        if (sku) existing = findProductBySku.get(sku);
        if (!existing) existing = findProductByName.get(name);

        if (existing) {
          updateProduct.run(price, desc, stock, unit, nameAr, barcode, existing.id);
          updated++;
        } else {
          insertProduct.run(sku, catRow.id, name, nameAr, price, desc, stock, unit, barcode);
          imported++;
        }
      }
    })();
  } catch (err) {
    logger.error(`Import transaction failed: ${err.message}`);
    throw err;
  }

  // Audit
  try {
    pdb.prepare(`
      INSERT INTO import_history
        (file_name, file_type, total_rows, imported_rows, failed_rows, status, ai_processed, imported_by, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run('inline-or-upload', 'csv', records.length, imported + updated, skipped, 'completed', 0, actor || null);
  } catch (e) {
    logger.warn('import_history write failed: ' + e.message);
  }

  return { imported, updated, skipped, warnings: allWarnings };
}

// ── Unified Pipeline ───────────────────────────────────────────────────

async function importPipeline(text, options = {}) {
  const format = detectFormat(text);
  if (format === 'empty') {
    return { imported: 0, updated: 0, skipped: 0, warnings: [{ row: 0, field: 'file', severity: 'error', message: 'الملف فارغ' }], report: '⚠️ لم يتم العثور على بيانات.' };
  }

  let records;
  let usedAI = false;

  if (format === 'natural' && !options.skipAI) {
    records = await parseWithAI(text);
    usedAI = true;
    if (!records || !records.length) {
      records = parseCSV(text);
      usedAI = false;
    }
  } else {
    records = parseCSV(text);
  }

  if (!records || !records.length) {
    return { imported: 0, updated: 0, skipped: 0, warnings: [{ row: 0, field: 'file', severity: 'error', message: 'لم يتم العثور على منتجات صالحة' }], report: '⚠️ لم يتم العثور على منتجات صالحة.' };
  }

  const result = importProducts(records, options);
  result.report = generateReport(result);
  result.usedAI = usedAI;
  result.totalRows = records.length;
  return result;
}

module.exports = { parseCSV, importProducts, detectFormat, parseDelimited, parseWithAI, validateRecord, generateReport, importPipeline, COLUMN_MAP };
