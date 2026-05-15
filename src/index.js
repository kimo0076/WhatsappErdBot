'use strict';

require('dotenv').config();

const logger = require('./utils/logger');
const { installGlobalHandlers } = require('./utils/errors');

installGlobalHandlers();

console.log('\nWhatsappErdBot starting...\n');

// ══════════════════════════════════════════
//  1. Migrations (in-process — no execSync)
// ══════════════════════════════════════════
const { migrate } = require('./database/migrate');

(async () => {
  try {
    await migrate();
  } catch (err) {
    logger.error('Migration failed: ' + (err.stack || err.message));
    process.exit(1);
  }

  // ────────────────────────────────────────
  //  2. Seed company + supervisors
  // ────────────────────────────────────────
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
      config.company.symbol || 'ر.س',
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
    // Keep supervisors in sync with config (re-add new ones, skip existing).
    const insertSup = mdb.prepare(
      'INSERT OR IGNORE INTO supervisors (phone_number, name, role) VALUES (?, ?, ?)',
    );
    for (const sup of config.supervisors || []) {
      insertSup.run(sup.phone, sup.name, sup.role || 'supervisor');
    }
    const info = mdb.prepare('SELECT name FROM company_info WHERE id = 1').get();
    logger.info(`${info.name} — database ready.`);
  }

  // ────────────────────────────────────────
  //  3. Wire WhatsApp + handlers + scheduler
  // ────────────────────────────────────────
  const WhatsAppClient = require('./core/WhatsAppClient');
  const MessageHandler = require('./handlers/MessageHandler');
  const Scheduler = require('./services/SchedulerService');

  const wa = new WhatsAppClient();
  const handler = new MessageHandler(wa);

  Scheduler.start(wa);

  // Health check server
  const HealthServer = require('./infrastructure/HealthServer');
  const health = new HealthServer({ port: parseInt(process.env.HEALTH_PORT) || 3099 });
  health.start();

  try {
    await wa.connect(async (event) => handler.handle(event));
    logger.info(`${config.company.name} — bot online.`);
  } catch (err) {
    logger.error('Fatal startup error: ' + (err.stack || err.message));
    process.exit(1);
  }

  // ────────────────────────────────────────
  //  4. Graceful shutdown
  // ────────────────────────────────────────
  const shutdown = (signal) => {
    logger.info(`${signal} received — shutting down gracefully...`);
    try { Scheduler.stop(); } catch (_) { /* noop */ }
    try { handler.shutdown && handler.shutdown(); } catch (_) { /* noop */ }
    try { health.stop(); } catch (_) { /* noop */ }
    try { db.close(); } catch (_) { /* noop */ }
    setTimeout(() => process.exit(0), 200);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
})();
