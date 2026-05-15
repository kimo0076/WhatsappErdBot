'use strict';

const logger = require('./logger');

/**
 * Per-key serial message queue.
 *
 * Why? Two messages from the same user can race when the handler awaits
 * the AI. Without serialization the second one can advance the state
 * machine before the first finishes (e.g. customer types "نعم" twice and
 * we create the order twice).
 *
 * Improvements over the previous in-line implementation:
 *   - automatic eviction of idle entries to prevent map growth
 *   - never resolves the chain to a rejection (downstream stays alive)
 *   - logs slow handlers for ops visibility
 */
class MessageQueue {
  constructor({ idleMs = 5 * 60 * 1000, slowMs = 10 * 1000 } = {}) {
    this._chains = new Map();   // key -> Promise
    this._lastUsed = new Map(); // key -> timestamp
    this.idleMs = idleMs;
    this.slowMs = slowMs;

    this._sweep = setInterval(() => this._evictIdle(), idleMs);
    this._sweep.unref();
  }

  /**
   * Run `task` serialized on `key`. Returns the task's resolved value.
   */
  async run(key, task) {
    const previous = this._chains.get(key) || Promise.resolve();

    let release;
    const next = previous.then(() => new Promise((r) => { release = r; }));
    this._chains.set(key, next);
    this._lastUsed.set(key, Date.now());

    await previous;

    const start = Date.now();
    try {
      return await task();
    } finally {
      const took = Date.now() - start;
      if (took > this.slowMs) {
        logger.warn(`Slow handler [${key}]: ${took}ms`);
      }
      release();
      // GC: drop only if we are the tail of the chain.
      if (this._chains.get(key) === next) {
        this._chains.delete(key);
      }
      this._lastUsed.set(key, Date.now());
    }
  }

  _evictIdle() {
    const cutoff = Date.now() - this.idleMs;
    for (const [key, ts] of this._lastUsed) {
      if (ts < cutoff && !this._chains.has(key)) {
        this._lastUsed.delete(key);
      }
    }
  }

  shutdown() {
    if (this._sweep) clearInterval(this._sweep);
  }
}

module.exports = MessageQueue;
