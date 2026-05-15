'use strict';

const db = require('../database/connection');
const settings = require('../utils/settings');
const logger = require('../utils/logger');

/**
 * Simple per-sender rate limiter backed by `rate_limit_events`.
 *
 * Why DB-backed?
 *   - survives restarts (in-memory limits would reset every redeploy),
 *   - lets a future ops dashboard query offenders cheaply,
 *   - SQLite WAL mode handles thousands of these writes per second.
 *
 * Two windows are enforced: per-minute and per-hour. Limits are read from
 * `system_settings` so they can be tuned without redeploys.
 */
class RateLimiter {
  constructor() {
    // Periodic cleanup of old events. Anything older than the largest
    // window we enforce (1h) is useless.
    this._cleanupInterval = setInterval(() => this._cleanup(), 10 * 60 * 1000);
    this._cleanupInterval.unref();
  }

  /**
   * Returns { allowed: boolean, retryAfter?: number, reason?: string }.
   */
  check(senderKey, bucket = 'message') {
    if (!senderKey) return { allowed: true };

    const perMin = settings.getInt('rate_limit_per_minute', 20);
    const perHour = settings.getInt('rate_limit_per_hour', 200);

    const mdb = db.getMain();
    const now = Date.now();

    const minuteCount = mdb.prepare(`
      SELECT COUNT(*) AS c FROM rate_limit_events
       WHERE sender_key = ? AND bucket = ?
         AND created_at >= datetime('now', '-60 seconds')
    `).get(senderKey, bucket).c;

    if (minuteCount >= perMin) {
      logger.warn(`Rate limit (per-min) hit for ${senderKey}: ${minuteCount}/${perMin}`);
      return { allowed: false, retryAfter: 60, reason: 'per_minute' };
    }

    const hourCount = mdb.prepare(`
      SELECT COUNT(*) AS c FROM rate_limit_events
       WHERE sender_key = ? AND bucket = ?
         AND created_at >= datetime('now', '-3600 seconds')
    `).get(senderKey, bucket).c;

    if (hourCount >= perHour) {
      logger.warn(`Rate limit (per-hour) hit for ${senderKey}: ${hourCount}/${perHour}`);
      return { allowed: false, retryAfter: 3600, reason: 'per_hour' };
    }

    mdb.prepare(
      'INSERT INTO rate_limit_events (sender_key, bucket) VALUES (?, ?)'
    ).run(senderKey, bucket);

    return { allowed: true, _now: now };
  }

  _cleanup() {
    try {
      const r = db.getMain().prepare(`
        DELETE FROM rate_limit_events WHERE created_at < datetime('now', '-2 hours')
      `).run();
      if (r.changes > 0) logger.info(`Rate limiter cleanup: removed ${r.changes} events`);
    } catch (err) {
      logger.warn(`Rate limiter cleanup failed: ${err.message}`);
    }
  }

  shutdown() {
    if (this._cleanupInterval) clearInterval(this._cleanupInterval);
  }
}

module.exports = new RateLimiter();
