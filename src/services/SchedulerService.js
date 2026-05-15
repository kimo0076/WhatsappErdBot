'use strict';

const config = require('../config/company.config');
const db = require('../database/connection');
const logger = require('../utils/logger');
const settings = require('../utils/settings');
const Order = require('./OrderService');
const phone = require('../utils/phone');
const { ORDER_STATUS } = require('../utils/constants');

class SchedulerService {
  constructor() {
    this.client = null;
    this._timers = [];
    this._lastReportDate = null;
  }

  start(client) {
    this.client = client;

    // Stale-order auto-cancel — once an hour.
    this._timers.push(setInterval(() => this._tickAutoCancel(), 60 * 60 * 1000));

    // Scheduled daily report — every 30 min, fires once after closing time.
    this._timers.push(setInterval(() => this._tickDailyReport(), 30 * 60 * 1000));

    // Run once at startup so we don't need to wait an hour for the first pass.
    setImmediate(() => this._tickAutoCancel());

    this._timers.forEach((t) => t.unref());
    logger.info('Scheduler started.');
  }

  stop() {
    this._timers.forEach((t) => clearInterval(t));
    this._timers = [];
  }

  _tickAutoCancel() {
    try {
      const hours = settings.getInt('auto_cancel_hours', config.orders?.autoCancelHours || 24);
      const cancelled = Order.autoCancelStale(hours);
      if (cancelled > 0) {
        logger.info(`Scheduler: auto-cancelled ${cancelled} stale orders (>${hours}h)`);
      }
    } catch (err) {
      logger.warn('Auto-cancel tick failed: ' + err.message);
    }
  }

  _tickDailyReport() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (this._lastReportDate === today) return;

      const endTime = settings.get('working_hours_end', '22:00') || '22:00';
      const [eh, em] = endTime.split(':').map(Number);
      const now = new Date();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), eh || 22, em || 0);
      if (now < end) return;

      this._lastReportDate = today;
      this._sendDailyReport();
    } catch (err) {
      logger.warn('Daily report tick failed: ' + err.message);
    }
  }

  _sendDailyReport() {
    if (!this.client) return;
    const company = config.company;
    const mdb = db.getMain();
    const pdb = db.getProducts();

    const orders = mdb.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status != ? THEN total_amount END), 0) AS revenue,
        SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS completed
      FROM orders WHERE date(created_at) = date('now')
    `).get(ORDER_STATUS.CANCELLED, ORDER_STATUS.COMPLETED);

    const threshold = settings.getInt('low_stock_alert', 10);
    const lowCount = pdb.prepare(`
      SELECT COUNT(*) AS c FROM products
       WHERE is_available = 1 AND stock_quantity > 0 AND stock_quantity <= ?
    `).get(threshold);

    const lines = [
      `🌙 *تقرير نهاية اليوم — ${company.name}*`,
      '',
      `🛒 الطلبات: ${orders.total || 0} | ✅ مكتملة: ${orders.completed || 0}`,
      `💰 الإيرادات: ${orders.revenue || 0} ${company.symbol}`,
      `⚠️ منخفضة المخزون: ${lowCount?.c || 0}`,
      '',
      'اكتب *تقرير مفصل* للتفاصيل الكاملة.',
    ];

    for (const sup of config.supervisors || []) {
      const supJid = phone.normalizeJid(sup.phone);
      this.client.sendTypingReply(supJid, lines.join('\n')).catch((err) => {
        logger.warn(`Daily report send failed for ${sup.phone}: ${err.message}`);
      });
    }
    logger.info(`Scheduler: daily report sent to ${(config.supervisors || []).length} supervisors`);
  }
}

module.exports = new SchedulerService();
