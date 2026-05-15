'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./connection');

function migrate() {
  console.log('🔄 Running migrations...\n');

  db.initialize();

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('  No migration files found.');
    return;
  }

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

    // 001_* → main.db, 002_* → products.db
    const targetDb = file.startsWith('002') ? db.getProducts() : db.getMain();

    // Ensure _migrations tracking table exists (for first run)
    targetDb.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        filename   TEXT    NOT NULL UNIQUE,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const already = targetDb.prepare(
      'SELECT id FROM _migrations WHERE filename = ?'
    ).get(file);

    if (already) {
      console.log(`  ⏭️  ${file} (already applied)`);
      continue;
    }

    try {
      targetDb.exec(sql);
      targetDb.prepare(
        'INSERT INTO _migrations (filename) VALUES (?)'
      ).run(file);
      console.log(`  ✅ ${file}`);
    } catch (err) {
      console.error(`  ❌ ${file}: ${err.message}`);
      throw err;
    }
  }

  console.log('\n✅ All migrations complete.\n');
  return Promise.resolve();
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
