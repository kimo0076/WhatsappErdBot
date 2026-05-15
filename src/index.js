'use strict';

require('dotenv').config();
const path = require('path');
const { execSync } = require('child_process');
const logger = require('./utils/logger');

console.log('\n🏗️  WhatsappErdBot v1.0\n');

// ══════════════════════════════════════════
//  Database Init + Migrations
// ══════════════════════════════════════════
logger.info('Running migrations...');
try {
  execSync(`node ${path.join(__dirname, 'database', 'migrate.js')}`, {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
} catch (err) {
  logger.error('Migration failed. Cannot start.');
  process.exit(1);
}

// ══════════════════════════════════════════
//  Seed company + supervisors
// ══════════════════════════════════════════
const db = require('./database/connection');
db.initialize();

const config = require('./config/company.config');
const mdb = db.getMain();

const existing = mdb.prepare('SELECT id FROM company_info WHERE id = 1').get();

if (!existing) {
  logger.info('First run — seeding company info and supervisors...');

  mdb.prepare(`
    INSERT INTO company_info
      (id, name, name_en, phone, email, address, city, country,
       currency, symbol, language, timezone, domain, website)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    config.company.name,
    config.company.nameEn || null,
    config.company.phone,
    config.company.email || null,
    config.company.address || null,
    config.company.city || null,
    config.company.country || 'SA',
    config.company.currency || 'SAR',
    config.company.symbol || '\u0631.\u0633',
    config.company.language || 'ar',
    config.company.timezone || 'Asia/Riyadh',
    config.company.domain || 'general',
    config.company.website || null,
  );

  const insertSup = mdb.prepare(
    'INSERT OR IGNORE INTO supervisors (phone_number, name, role) VALUES (?, ?, ?)',
  );
  for (const sup of config.supervisors) {
    insertSup.run(sup.phone, sup.name, sup.role || 'supervisor');
    logger.info(`  Supervisor: ${sup.name} (${sup.phone})`);
  }
  logger.info(`${config.company.name} initialized.`);
} else {
  const info = mdb.prepare('SELECT name FROM company_info WHERE id = 1').get();
  logger.info(`${info.name} — database ready.`);
}

// ══════════════════════════════════════════
//  WhatsApp Connection
// ══════════════════════════════════════════
const WhatsAppClient = require('./core/WhatsAppClient');
const MessageHandler = require('./handlers/MessageHandler');

const wa = new WhatsAppClient();
const handler = new MessageHandler(wa);

async function start() {
  await wa.connect(async (event) => {
    await handler.handle(event);
  });

  logger.info(`✅ ${config.company.name} — bot online.`);
}

start().catch((err) => {
  logger.error('Fatal startup error: ' + err.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  db.close();
  logger.info('Bye 👋');
  process.exit(0);
});
