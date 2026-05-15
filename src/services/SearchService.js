'use strict';

const db = require('../database/connection');

class SearchService {
  constructor() {
    this._nameCache = null;
    this._cacheTime = 0;
    this._cacheTTL = 30000;
  }

  // ── Normalization ───────────────────────────────────────────────────

  normalizeArabic(text) {
    return text
      .replace(/[أإآ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/[ىي]/g, 'ي')
      .replace(/\u0640/g, '')
      .replace(/[ًٌٍَُِّْ]/g, '')
      .toLowerCase()
      .trim();
  }

  normalizeEnglish(text) {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  }

  normalize(text) {
    if (!text) return '';
    const hasArabic = /[\u0600-\u06FF]/.test(text);
    return hasArabic ? this.normalizeArabic(text) : this.normalizeEnglish(text);
  }

  // ── Layer 1: Exact match ────────────────────────────────────────────

  searchExact(query) {
    const pdb = db.getProducts();
    const like = `%${query}%`;
    const normalized = this.normalize(query);

    const results = pdb.prepare(`
      SELECT p.*, c.name AS category_name
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.is_available = 1 AND p.stock_quantity > 0
         AND (p.name LIKE ? OR p.name_ar LIKE ? OR p.sku LIKE ? OR p.barcode = ? OR p.description LIKE ?)
       ORDER BY p.total_sold DESC, p.name ASC
       LIMIT 5
    `).all(like, like, like, query, like);

    if (results.length) return results;

    if (normalized !== query) {
      return pdb.prepare(`
        SELECT p.*, c.name AS category_name
          FROM products p
          LEFT JOIN categories c ON p.category_id = c.id
         WHERE p.is_available = 1 AND p.stock_quantity > 0
           AND (p.name LIKE ? OR p.name_ar LIKE ? OR p.sku LIKE ?)
         ORDER BY p.total_sold DESC, p.name ASC
         LIMIT 5
      `).all(`%${normalized}%`, `%${normalized}%`, `%${normalized}%`);
    }
    return [];
  }

  // ── Layer 2: Fuzzy match ────────────────────────────────────────────

  _loadNameCache() {
    const now = Date.now();
    if (this._nameCache && (now - this._cacheTime) < this._cacheTTL) {
      return this._nameCache;
    }
    const rows = db.getProducts().prepare(`
      SELECT id, name, COALESCE(name_ar, '') AS name_ar, sku,
             COALESCE(discount_price, price) AS price,
             stock_quantity, is_available
        FROM products
    `).all();
    this._nameCache = rows;
    this._cacheTime = now;
    return rows;
  }

  levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    return dp[m][n];
  }

  searchFuzzy(query) {
    const q = this.normalize(query);
    if (!q) return [];

    const candidates = this._loadNameCache();
    const threshold = q.length <= 6 ? 2 : 3;

    const scored = candidates
      .map((p) => {
        const nameDist = this.levenshtein(this.normalize(p.name), q);
        const arDist = p.name_ar
          ? this.levenshtein(this.normalizeArabic(p.name_ar), q)
          : 999;
        const skuDist = p.sku ? this.levenshtein(p.sku.toLowerCase(), q) : 999;
        const dist = Math.min(nameDist, arDist, skuDist);
        return { ...p, _dist: dist };
      })
      .filter((p) => p._dist <= threshold)
      .sort((a, b) => a._dist - b._dist)
      .slice(0, 5);

    if (!scored.length) return [];

    return db.getProducts().prepare(`
      SELECT p.*, c.name AS category_name
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.id IN (${scored.map(() => '?').join(',')})
       ORDER BY p.total_sold DESC, p.name ASC
    `).all(...scored.map((s) => s.id));
  }

  // ── Suggestions ─────────────────────────────────────────────────────

  suggestAlternatives(query) {
    const q = this.normalize(query);
    if (!q) return [];

    const candidates = this._loadNameCache();
    const threshold = q.length <= 4 ? 3 : 4;

    return candidates
      .filter((p) => p.is_available)
      .map((p) => {
        const nameDist = this.levenshtein(this.normalize(p.name), q);
        const arDist = p.name_ar
          ? this.levenshtein(this.normalizeArabic(p.name_ar), q)
          : 999;
        return { ...p, _dist: Math.min(nameDist, arDist) };
      })
      .filter((p) => p._dist <= threshold)
      .sort((a, b) => a._dist - b._dist)
      .slice(0, 3)
      .map((p) => p.name);
  }

  // ── Hybrid ──────────────────────────────────────────────────────────

  hybridSearch(query) {
    let results = this.searchExact(query);
    if (results.length) return { results, method: 'exact' };

    results = this.searchFuzzy(query);
    if (results.length) return { results, method: 'fuzzy' };

    return { results: [], method: null };
  }

  bestMatch(query) {
    const { results } = this.hybridSearch(query);
    return results[0] || null;
  }

  bestMatchAll(query) {
    const { results } = this.hybridSearch(query);
    return results;
  }
}

module.exports = new SearchService();
