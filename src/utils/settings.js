'use strict';

const db = require('../database/connection');

/**
 * Tiny memoized accessor for `system_settings`. Reads are cheap with SQLite,
 * but the same keys (rate limits, low-stock threshold, ...) are read on
 * almost every message. We cache for a short window with manual invalidation
 * when settings are written through this module.
 */

const TTL_MS = 30 * 1000;
const cache = new Map(); // key -> { value, expiresAt }

function get(key, fallback = null) {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const row = db.getMain().prepare(
    'SELECT value FROM system_settings WHERE key = ?'
  ).get(key);

  const value = row ? row.value : fallback;
  cache.set(key, { value, expiresAt: now + TTL_MS });
  return value;
}

function getInt(key, fallback) {
  const raw = get(key, null);
  if (raw == null) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getBool(key, fallback) {
  const raw = get(key, null);
  if (raw == null) return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw));
}

function set(key, value) {
  db.getMain().prepare(`
    INSERT INTO system_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value));
  cache.delete(key);
}

function invalidate() {
  cache.clear();
}

module.exports = { get, getInt, getBool, set, invalidate };
