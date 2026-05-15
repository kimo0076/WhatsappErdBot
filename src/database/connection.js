'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class DatabaseConnection {
  constructor() {
    this.mainDb = null;
    this.productsDb = null;
  }

  initialize() {
    const mainPath = process.env.MAIN_DB_PATH || './data/database/main.db';
    const productsPath = process.env.PRODUCTS_DB_PATH || './data/database/products.db';

    [mainPath, productsPath].forEach((p) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
    });

    this.mainDb = new Database(mainPath);
    this.productsDb = new Database(productsPath);

    [this.mainDb, this.productsDb].forEach((db) => {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.pragma('synchronous = NORMAL');
      db.pragma('cache_size = -8000');
      db.pragma('temp_store = MEMORY');
    });

    console.log('✅ Databases connected (main.db + products.db)');
    return this;
  }

  getMain() {
    return this.mainDb;
  }

  getProducts() {
    return this.productsDb;
  }

  close() {
    if (this.mainDb) this.mainDb.close();
    if (this.productsDb) this.productsDb.close();
    console.log('Databases closed');
  }
}

module.exports = new DatabaseConnection();
