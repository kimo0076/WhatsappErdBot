'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

/**
 * Singleton DB connection manager.
 *
 * - main.db   : business state (orders, customers, conversations, ...)
 * - products.db: catalog + inventory
 *
 * The two are intentionally separated to allow simple per-tenant catalog
 * swaps and reduce contention on hot order writes.
 */
class DatabaseConnection {
  constructor() {
    this.mainDb = null;
    this.productsDb = null;
    this._initialized = false;
  }

  initialize() {
    if (this._initialized) return this;

    const mainPath = process.env.MAIN_DB_PATH || './data/database/main.db';
    const productsPath = process.env.PRODUCTS_DB_PATH || './data/database/products.db';

    [mainPath, productsPath].forEach((p) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
    });

    this.mainDb = new Database(mainPath);
    this.productsDb = new Database(productsPath);

    [this.mainDb, this.productsDb].forEach((conn) => {
      conn.pragma('journal_mode = WAL');
      conn.pragma('foreign_keys = ON');
      conn.pragma('synchronous = NORMAL');
      conn.pragma('cache_size = -8000');
      conn.pragma('temp_store = MEMORY');
      conn.pragma('busy_timeout = 5000');
    });

    this._initialized = true;
    console.log('Databases connected (main.db + products.db)');
    return this;
  }

  getMain() {
    if (!this.mainDb) this.initialize();
    return this.mainDb;
  }

  getProducts() {
    if (!this.productsDb) this.initialize();
    return this.productsDb;
  }

  /**
   * Run a function inside a transaction on the main DB.
   * Returns whatever the function returns; rolls back on throw.
   */
  txMain(fn) {
    const tx = this.getMain().transaction(fn);
    return tx();
  }

  /**
   * Run a function inside a transaction on the products DB.
   */
  txProducts(fn) {
    const tx = this.getProducts().transaction(fn);
    return tx();
  }

  close() {
    if (this.mainDb) {
      try { this.mainDb.close(); } catch (_) { /* noop */ }
    }
    if (this.productsDb) {
      try { this.productsDb.close(); } catch (_) { /* noop */ }
    }
    this._initialized = false;
    console.log('Databases closed');
  }
}

module.exports = new DatabaseConnection();
