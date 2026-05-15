'use strict';

const db = require('../database/connection');
const settings = require('../utils/settings');
const logger = require('../utils/logger');

/**
 * Persisted idempotency for inbound WhatsApp messages.
 *
 * Baileys can redeliver the same message after a decryption retry or
 * client restart. The original code used an in-memory Set, which lost
 * its state on restart and let duplicates through.
 *
 * Here we acquire a unique key (typically the WhatsApp message id) and
 * if the insert succeeds we proceed, otherwise we drop the duplicate.
 */
class IdempotencyService {
  constructor() {
    this._cleanupInterval = setInterval(() => this._cleanup(), 30 * 60 * 1000);
    this._cleanupInterval.unref();
  }

  /**
   * Returns true if the key was newly acquired (process the message),
   * false if it was already seen (drop it).
   */
  acquire(key, scope = 'wa_message') {
    if (!key) return true;
    const mdb = db.getMain();
    try {
      mdb.prepare(
        'INSERT INTO idempotency_keys (key, scope) VALUES (?, ?)'
      ).run(`${scope}:${key}`, scope);
      return true;
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return false;
      // Anything else: log and let processing continue rather than dropping.
      logger.warn(`Idempotency acquire error: ${err.message}`);
      return true;
    }
  }

  _cleanup() {
    try {
      const ttl = settings.getInt('idempotency_ttl_hours', 48);
      const r = db.getMain().prepare(`
        DELETE FROM idempotency_keys WHERE created_at < datetime('now', '-' || ? || ' hours')
      `).run(ttl);
      if (r.changes > 0) logger.info(`Idempotency cleanup: ${r.changes} keys removed`);
    } catch (err) {
      logger.warn(`Idempotency cleanup failed: ${err.message}`);
    }
  }

  shutdown() {
    if (this._cleanupInterval) clearInterval(this._cleanupInterval);
  }
}

module.exports = new IdempotencyService();
