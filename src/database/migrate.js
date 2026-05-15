'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./connection');

/**
 * Migration runner.
 *
 * Routing rule: each migration file is routed to a database based on the first
 * occurrence of `main` or `products` in its filename. This is more flexible
 * than the legacy "002 prefix means products" rule and lets us add new
 * migrations to either DB without renumbering.
 *
 * Files are applied in lexicographic order. Each DB tracks its own
 * `_migrations` table, so a file targeted at the products DB does NOT
 * appear in the main DB's history (and vice versa).
 */
function routeFor(filename) {
  if (/products/i.test(filename)) return 'products';
  if (/main/i.test(filename)) return 'main';
  // Backwards compatibility with the original numbering scheme.
  if (filename.startsWith('002')) return 'products';
  return 'main';
}

function ensureMigrationsTable(target) {
  target.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      filename   TEXT    NOT NULL UNIQUE,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function migrate() {
  console.log('Running migrations...\n');

  db.initialize();

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('  No migration files found.');
    return Promise.resolve();
  }

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const route = routeFor(file);
    const target = route === 'products' ? db.getProducts() : db.getMain();

    ensureMigrationsTable(target);

    const already = target.prepare(
      'SELECT id FROM _migrations WHERE filename = ?'
    ).get(file);

    if (already) {
      console.log(`  - ${file} (already applied to ${route}.db)`);
      continue;
    }

    try {
      // We can't BEGIN/COMMIT around the file because some SQLite PRAGMAs
      // (notably `journal_mode`) cannot run inside a transaction. SQLite
      // executes DDL statement-by-statement; if a migration fails midway
      // the bookkeeping row below is NOT inserted, so the next run will
      // try to re-apply the file (with `IF NOT EXISTS` guards making the
      // already-applied parts idempotent).
      target.exec(sql);
      target.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      console.log(`  + ${file} -> ${route}.db`);
    } catch (err) {
      console.error(`  ! ${file}: ${err.message}`);
      throw err;
    }
  }

  console.log('\nAll migrations complete.\n');
  return Promise.resolve();
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
  });
}

module.exports = { migrate, routeFor };
