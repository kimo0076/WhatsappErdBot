'use strict';

const config = require('../config/company.config');
const db = require('../database/connection');
const logger = require('../utils/logger');
const Order = require('../services/OrderService');
const Inventory = require('../services/InventoryService');
const ImportService = require('../services/ImportService');
const AI = require('../ai/AIService');
const phoneUtil = require('../utils/phone');
const settings = require('../utils/settings');
const {
  ORDER_STATUS,
  STATUS_LABELS_AR,
} = require('../utils/constants');

// Bug #6: More flexible order number regex
// Accepts: ORD-20260515-003, 003-20260515, 003-20260515-ORD, ORD-20260515-003
const ORDER_NUMBER_RE = /(ord-?\d{8}-\d{3}|\d{3,8}[-\s]\d{3,8}(?:-(?:\d{3}|ord))?)/i;
const PHONE_RE = /(\+\d{7,15}|\d{7,15})/;

/**
 * Supervisor command handler.
 *
 * Each command is a small async method, registered in a single
 * dispatch table built once in the constructor for clarity.
 */
class SupervisorHandler {
  constructor(client) {
    this.client = client;
    this._commands = this._buildCommands();
  }

  async handle(event, phone) {
    const { jid, text, document } = event;

    if (document) {
      logger.info(`  📄 Supervisor [${phone}]: importing ${document.fileName}`);
      return this._handleDocumentImport(jid, phone, document);
    }

    if (!text) return;
    const lower = text.trim().toLowerCase();

    for (const cmd of this._commands) {
      const m = cmd.match(lower);
      if (m) {
        logger.info(`  🤖 Supervisor [${phone}]: ${cmd.name}`);
        try {
          await cmd.run(jid, phone, m, text);
        } catch (err) {
          logger.error(`Supervisor command "${cmd.name}" failed: ${err.message}`);
          await this._reply(jid, `حدث خطأ أثناء تنفيذ الأمر: ${err.message}`);
        }
        return;
      }
    }

    // Detect partial commands missing an order number.
    if (/^(حالة|موافقة|رفض|توصيل|تعيين|انهاء|إنهاء)$/i.test(lower)) {
      logger.info(`  ℹ️ Supervisor [${phone}]: partial command`);
      return this._reply(jid,
        '⚠️ الرجاء إدخال رقم الطلب مع الأمر.\n' +
        'مثال: *موافقة ORD-20260515-001*');
    }

    // Detect ad-hoc CSV pasted as a single message.
    if ((text.match(/,/g) || []).length >= 2) {
      logger.info(`  📄 Supervisor [${phone}]: possible CSV data`);
      const handled = await this._tryImportCSV(jid, phone, text);
      if (handled) return;
    }

    logger.info(`  👋 Supervisor [${phone}]: help`);
    return this._sendHelp(jid);
  }

  // ────────────────────────────────────────────────────────────────────
  // Helper: resolve flexible order number to canonical form
  // ────────────────────────────────────────────────────────────────────

  _resolveOrderNumber(input) {
    if (!input) return null;
    const order = Order.getByNumberFlexible(input);
    return order ? order.order_number : null;
  }

  // ────────────────────────────────────────────────────────────────────
  // Reply helper
  // ────────────────────────────────────────────────────────────────────

  async _reply(jid, text) {
    const result = await this.client.sendTypingReply(jid, text);
    const preview = text.replace(/\n/g, ' ').substring(0, 60);
    logger.info(`  Replied supervisor [${jid}]: ${preview}…`);
    return result;
  }

  // ────────────────────────────────────────────────────────────────────
  // Command registration
  // ────────────────────────────────────────────────────────────────────

  _buildCommands() {
    const exact = (re) => (lower) => (re.test(lower) ? [] : null);
    const captured = (re) => (lower) => {
      const m = lower.match(re);
      return m ? m.slice(1) : null;
    };

    return [
      { name: 'orders', match: exact(/^(orders|\/orders|طلبات|عرض الطلبات|الطلبات)$/i),
        run: (jid) => this._cmdOrders(jid) },

      { name: 'detailedReport', match: exact(/^(report|\/report|تقرير مفصّل|تقرير مفصل|تقرير كامل)$/i),
        run: (jid) => this._cmdReport(jid) },

      { name: 'stats', match: exact(/^(stats|\/stats|احصائيات|تقرير|تقرير اليوم)$/i),
        run: (jid) => this._cmdStats(jid) },

      { name: 'stock', match: exact(/^(stock|stocks|\/stock|\/stocks|مخزون|المخزون|جرد)$/i),
        run: (jid) => this._cmdStock(jid) },

      { name: 'lowStock', match: exact(/^(lowstock|\/lowstock|ناقص|منخفض|تنبيه)$/i),
        run: (jid) => this._cmdLowStock(jid) },

      // Bug #5: Auto-approve toggle command
      { name: 'autoApprove', match: exact(/^(تلقائي|auto|\/auto|auto.?approve)$/i),
        run: (jid, phone) => this._cmdAutoApprove(jid, phone) },

      // Bug #6: Flexible order number matching
      { name: 'approve', match: captured(/^(?:approve|\/approve|موافقة)\s+((?:ord-?)?\d{3,8}[-\s]?\d{3,8}(?:-(?:\d{3}|ord))?)$/i),
        run: (jid, phone, [orderInput]) => this._cmdApprove(jid, phone, orderInput) },

      { name: 'reject', match: captured(/^(?:reject|\/reject|رفض)\s+((?:ord-?)?\d{3,8}[-\s]?\d{3,8}(?:-(?:\d{3}|ord))?)\s*(?:\s+(.+))?$/i),
        run: (jid, phone, [orderInput, reason]) =>
          this._cmdReject(jid, phone, orderInput, reason || null) },

      { name: 'status', match: captured(/^(?:status|\/status|حالة|تفاصيل)\s+((?:ord-?)?\d{3,8}[-\s]?\d{3,8}(?:-(?:\d{3}|ord))?)$/i),
        run: (jid, phone, [orderInput]) => this._cmdStatus(jid, orderInput) },

      { name: 'deliver', match: captured(/^(?:deliver|\/deliver|توصيل|شحن)\s+((?:ord-?)?\d{3,8}[-\s]?\d{3,8}(?:-(?:\d{3}|ord))?)$/i),
        run: (jid, phone, [orderInput]) => this._cmdDeliver(jid, phone, orderInput) },

      { name: 'complete', match: captured(/^(?:complete|\/complete|مكتمل|انهاء|إنهاء)\s+((?:ord-?)?\d{3,8}[-\s]?\d{3,8}(?:-(?:\d{3}|ord))?)$/i),
        run: (jid, phone, [orderInput]) => this._cmdComplete(jid, phone, orderInput) },

      { name: 'assign',
        match: captured(/^(?:assign|\/assign|تعيين)\s+((?:ord-?)?\d{3,8}[-\s]?\d{3,8}(?:-(?:\d{3}|ord))?)\s+(\+?\d{7,15})(?:\s+(.+))?$/i),
        run: (jid, phone, [orderInput, delPhone, notes]) =>
          this._cmdAssign(jid, phone, orderInput,
            delPhone.startsWith('+') ? delPhone : '+' + delPhone, notes || null) },

      { name: 'importInline',
        match: captured(/^(?:import|\/import|استيراد)\s+(.+)$/i),
        run: (jid, phone, [data]) => this._handleInlineImport(jid, phone, data) },

      { name: 'importHelp', match: exact(/^(import|\/import|استيراد)$/i),
        run: (jid) => this._cmdImportHelp(jid) },
    ];
  }


  // ────────────────────────────────────────────────────────────────────
  // Commands
  // ────────────────────────────────────────────────────────────────────

  async _cmdOrders(jid) {
    const orders = Order.listPending(20);
    if (!orders.length) {
      return this.client.sendTypingReply(jid, '✅ لا توجد طلبات معلقة.');
    }

    const company = config.company;
    const lines = ['📋 *الطلبات المعلقة:*', ''];
    for (const o of orders) {
      const items = Order.getItems(o.id);
      const flag = o.status === ORDER_STATUS.PENDING_APPROVAL ? '🔴' : '🟡';
      lines.push(`${flag} *${o.order_number}*`);
      items.forEach((it) => {
        lines.push(`   📦 ${it.product_name} — ${it.quantity}x × ${it.unit_price} ${company.symbol}`);
      });
      lines.push(`   💰 ${o.total_amount} ${company.symbol}`);
      lines.push(`   📱 ${phoneUtil.formatForDisplay(o.customer_phone)}`);
      lines.push(`   🕐 ${o.created_at}`);
      lines.push(`   ${STATUS_LABELS_AR[o.status] || o.status}`);
      lines.push('');
    }
    lines.push('---');
    lines.push('🔹 *موافقة ORD-xxxxx*');
    lines.push('🔹 *رفض ORD-xxxxx [سبب]*');
    await this.client.sendTypingReply(jid, lines.join('\n'));
  }

  // Bug #5: Auto-approve toggle
  async _cmdAutoApprove(jid, phone) {
    const current = settings.getBool('auto_approve_orders', false);
    const newValue = !current;
    settings.set('auto_approve_orders', newValue ? 'true' : 'false');

    const statusText = newValue
      ? '✅ *تم تفعيل القبول التلقائي*\n\nالطلبات الجديدة ستُقبل تلقائياً بدون الحاجة لموافقة المشرف (ما لم يكن المخزون غير كافٍ).'
      : '❌ *تم إيقاف القبول التلقائي*\n\nالطلبات التي تحتاج مراجعة ستنتظر موافقة المشرف.';

    logger.info(`Auto-approve toggled to ${newValue} by ${phone}`);
    await this.client.sendTypingReply(jid, statusText);
  }

  async _cmdApprove(jid, supPhone, orderInput) {
    const orderNumber = this._resolveOrderNumber(orderInput);
    if (!orderNumber) {
      return this.client.sendTypingReply(jid, `❌ الطلب "${orderInput}" غير موجود.`);
    }

    const r = Order.approve(orderNumber, supPhone);
    if (!r.ok) {
      const reasonMap = {
        NOT_FOUND: `❌ الطلب ${orderNumber} غير موجود.`,
        CANCELLED: `❌ الطلب ${orderNumber} ملغي.`,
        COMPLETED: `❌ الطلب ${orderNumber} مكتمل بالفعل.`,
        OUT_OF_STOCK: `❌ تعذر الموافقة: المخزون غير كافٍ. تم إعادة الطلب لحالة الانتظار.`,
      };
      return this.client.sendTypingReply(jid, reasonMap[r.reason] || `❌ فشلت الموافقة (${r.reason})`);
    }

    await this.client.sendTypingReply(jid, `✅ تمت الموافقة على الطلب ${orderNumber}.`);
    if (r.order.whatsapp_jid) {
      this.client.sendTypingReply(r.order.whatsapp_jid,
        `✅ *تمت الموافقة على طلبك!*\n` +
        `🆔 رقم الطلب: *${orderNumber}*\n` +
        `سنقوم بتجهيز طلبك والتواصل معك قريباً.`
      ).catch((err) => logger.warn(`Notify customer ${orderNumber} failed: ${err.message}`));
    }
  }

  async _cmdReject(jid, supPhone, orderInput, reason) {
    const orderNumber = this._resolveOrderNumber(orderInput);
    if (!orderNumber) {
      return this.client.sendTypingReply(jid, `❌ الطلب "${orderInput}" غير موجود.`);
    }

    const r = Order.reject(orderNumber, supPhone, reason);
    if (!r.ok) {
      const reasonMap = {
        NOT_FOUND: `❌ الطلب ${orderNumber} غير موجود.`,
        ALREADY_CANCELLED: `❌ الطلب ${orderNumber} ملغي بالفعل.`,
      };
      return this.client.sendTypingReply(jid, reasonMap[r.reason] || `❌ ${r.reason}`);
    }
    await this.client.sendTypingReply(jid, `❌ تم رفض الطلب ${orderNumber}.`);
    if (r.order.whatsapp_jid) {
      const reasonText = reason ? `\n📝 السبب: ${reason}\n` : '\n';
      this.client.sendTypingReply(r.order.whatsapp_jid,
        `❌ *نأسف! تم رفض طلبك*\n\n` +
        `🆔 رقم الطلب: *${orderNumber}*\n` +
        reasonText +
        `يمكنك الاطلاع على منتجات أخرى بكتابة *منتجات*`
      ).catch((err) => logger.warn(`Notify customer ${orderNumber} failed: ${err.message}`));
    }
  }

  async _cmdStatus(jid, orderInput) {
    const orderNumber = this._resolveOrderNumber(orderInput);
    if (!orderNumber) {
      return this.client.sendTypingReply(jid, `❌ الطلب "${orderInput}" غير موجود.`);
    }

    const order = Order.getByNumber(orderNumber);
    if (!order) {
      return this.client.sendTypingReply(jid, `❌ الطلب ${orderNumber} غير موجود.`);
    }
    const items = Order.getItems(order.id);
    const company = config.company;

    const lines = [
      `🔍 *تفاصيل الطلب ${orderNumber}*`,
      '',
      `📱 العميل: ${phoneUtil.formatForDisplay(order.phone_number)}`,
      `📌 الحالة: ${STATUS_LABELS_AR[order.status] || order.status}`,
      '',
      '📦 *المنتجات:*',
    ];
    items.forEach((it) => {
      lines.push(`   • ${it.product_name} — ${it.quantity}x × ${it.unit_price} ${company.symbol}`);
    });
    lines.push(`💰 الإجمالي: ${order.total_amount} ${company.symbol}`);
    if (order.delivery_address) lines.push(`📍 العنوان: ${order.delivery_address}`);
    if (order.delivery_phone) lines.push(`🚚 مندوب التوصيل: ${order.delivery_phone}`);
    if (order.delivery_notes) lines.push(`📝 ملاحظات التوصيل: ${order.delivery_notes}`);
    if (order.customer_message) lines.push(`💬 رسالة العميل: ${order.customer_message}`);
    if (order.cancellation_reason) lines.push(`📝 سبب الإلغاء: ${order.cancellation_reason}`);
    lines.push(`🕐 أنشئ: ${order.created_at}`);

    await this.client.sendTypingReply(jid, lines.join('\n'));
  }

  async _cmdDeliver(jid, supPhone, orderInput) {
    const orderNumber = this._resolveOrderNumber(orderInput);
    if (!orderNumber) {
      return this.client.sendTypingReply(jid, `❌ الطلب "${orderInput}" غير موجود.`);
    }

    const r = Order.markInTransit(orderNumber, supPhone);
    if (!r.ok) return this._sendOrderError(jid, orderNumber, r.reason);
    await this.client.sendTypingReply(jid, `🚚 تم تحديث الطلب ${orderNumber} — قيد التوصيل.`);
    if (r.order.whatsapp_jid) {
      this.client.sendTypingReply(r.order.whatsapp_jid,
        `🚚 *طلبك ${orderNumber} في الطريق!*\nسيصلك مندوب التوصيل قريباً 📞`
      ).catch(() => {});
    }
  }

  async _cmdComplete(jid, supPhone, orderInput) {
    const orderNumber = this._resolveOrderNumber(orderInput);
    if (!orderNumber) {
      return this.client.sendTypingReply(jid, `❌ الطلب "${orderInput}" غير موجود.`);
    }

    const r = Order.complete(orderNumber, supPhone);
    if (!r.ok) return this._sendOrderError(jid, orderNumber, r.reason);
    await this.client.sendTypingReply(jid, `🏁 تم إكمال الطلب ${orderNumber}.`);
    if (r.order.whatsapp_jid) {
      this.client.sendTypingReply(r.order.whatsapp_jid,
        `🏁 *تم إكمال طلبك ${orderNumber}!*\nنشكرك على ثقتك.\nيسعدنا خدمتك دائماً.`
      ).catch(() => {});
    }
  }

  async _cmdAssign(jid, supPhone, orderInput, deliveryPhone, notes) {
    const orderNumber = this._resolveOrderNumber(orderInput);
    if (!orderNumber) {
      return this.client.sendTypingReply(jid, `❌ الطلب "${orderInput}" غير موجود.`);
    }

    const r = Order.assignDelivery(orderNumber, supPhone, deliveryPhone, notes);
    if (!r.ok) return this._sendOrderError(jid, orderNumber, r.reason);
    await this.client.sendTypingReply(jid,
      `🚚 تم تعيين مندوب التوصيل (${deliveryPhone}) للطلب ${orderNumber}.` +
      (notes ? `\n📝 ${notes}` : ''));
  }

  _sendOrderError(jid, orderNumber, reason) {
    const map = {
      NOT_FOUND: `❌ الطلب ${orderNumber} غير موجود.`,
      CANCELLED: `❌ الطلب ${orderNumber} ملغي.`,
      ALREADY_CANCELLED: `❌ الطلب ${orderNumber} ملغي بالفعل.`,
    };
    return this.client.sendTypingReply(jid, map[reason] || `❌ ${reason}`);
  }


  async _cmdStats(jid) {
    const company = config.company;
    const mdb = db.getMain();
    const pdb = db.getProducts();

    const today = mdb.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('pending', 'pending_supervisor_approval') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status IN ('confirmed', 'in_transit', 'delivered', 'completed') THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
        COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total_amount ELSE 0 END), 0) AS revenue
      FROM orders WHERE date(created_at) = date('now')
    `).get();

    const threshold = settings.getInt('low_stock_alert', 10);
    const inv = pdb.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN stock_quantity > 0 THEN 1 ELSE 0 END) AS available,
        SUM(CASE WHEN stock_quantity = 0 THEN 1 ELSE 0 END) AS out_of_stock,
        SUM(CASE WHEN stock_quantity > 0 AND stock_quantity <= ? THEN 1 ELSE 0 END) AS low
      FROM products WHERE is_available = 1
    `).get(threshold);

    const autoApprove = settings.getBool('auto_approve_orders', false);
    const autoLabel = autoApprove ? '✅ مفعّل' : '❌ معطّل';

    await this.client.sendTypingReply(jid,
      `📊 *التقرير*\n\n` +
      `🛒 الطلبات\n` +
      `  إجمالي: ${today.total || 0}\n` +
      `  معلقة: ${today.pending || 0}\n` +
      `  مؤكدة: ${today.active || 0}\n` +
      `  ملغية: ${today.cancelled || 0}\n` +
      `💰 الإيرادات: ${today.revenue || 0} ${company.symbol}\n\n` +
      `📦 المخزون\n` +
      `  إجمالي: ${inv.total || 0}\n` +
      `  متوفرة: ${inv.available || 0}\n` +
      `  ⚠️ منخفضة: ${inv.low || 0}\n` +
      `  ❌ غير متوفرة: ${inv.out_of_stock || 0}\n\n` +
      `⚙️ القبول التلقائي: ${autoLabel}`);
  }

  async _cmdReport(jid) {
    const company = config.company;
    const mdb = db.getMain();
    const pdb = db.getProducts();
    const threshold = settings.getInt('low_stock_alert', 10);

    const orders = mdb.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total_amount END), 0) AS revenue,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN status IN ('pending', 'pending_supervisor_approval') THEN 1 ELSE 0 END) AS pending
      FROM orders WHERE date(created_at) = date('now')
    `).get();

    const topProducts = pdb.prepare(`
      SELECT name, total_sold, stock_quantity FROM products
       WHERE total_sold > 0 ORDER BY total_sold DESC LIMIT 5
    `).all();

    const lowStock = pdb.prepare(`
      SELECT COUNT(*) AS count FROM products
       WHERE is_available = 1 AND stock_quantity > 0 AND stock_quantity <= ?
    `).get(threshold);

    const newCustomers = mdb.prepare(`
      SELECT COUNT(*) AS count FROM customers WHERE date(created_at) = date('now')
    `).get();

    const inv = pdb.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN stock_quantity > 0 THEN 1 ELSE 0 END) AS available
      FROM products WHERE is_available = 1
    `).get();

    const lines = [`📊 *تقرير يومي — ${company.name}*`, ''];
    lines.push('🛒 *الطلبات*');
    lines.push(`  الإجمالي: ${orders.total || 0}`);
    lines.push(`  المعلقة: ${orders.pending || 0}`);
    lines.push(`  المكتملة: ${orders.completed || 0}`);
    lines.push(`  الملغية: ${orders.cancelled || 0}`);
    lines.push(`💰 الإيرادات: ${orders.revenue || 0} ${company.symbol}`);
    lines.push('');
    lines.push('👥 *العملاء*');
    lines.push(`  الجدد اليوم: ${newCustomers.count || 0}`);
    lines.push('');
    lines.push('📦 *المخزون*');
    lines.push(`  الإجمالي: ${inv.total || 0} | متوفر: ${inv.available || 0}`);
    lines.push(`  ⚠️ منخفض: ${lowStock.count || 0} (أقل من ${threshold})`);
    if (topProducts.length) {
      lines.push('');
      lines.push('⭐ *الأكثر مبيعاً*');
      for (const p of topProducts) {
        lines.push(`  • ${p.name} — ${p.total_sold} مباع — ${p.stock_quantity} متبقي`);
      }
    }
    await this.client.sendTypingReply(jid, lines.join('\n'));
  }

  async _cmdStock(jid) {
    const pdb = db.getProducts();
    const products = pdb.prepare(`
      SELECT p.*, c.name AS category_name
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
       ORDER BY c.sort_order, p.name
    `).all();

    if (!products.length) {
      return this.client.sendTypingReply(jid, '📦 المخزون فارغ حالياً.');
    }

    const company = config.company;
    const threshold = settings.getInt('low_stock_alert', 10);
    const grouped = {};
    for (const p of products) {
      const cat = p.category_name || 'بدون فئة';
      (grouped[cat] = grouped[cat] || []).push(p);
    }

    const lines = ['📦 *المخزون*', ''];
    let totalAvailable = 0;
    let totalOut = 0;

    for (const [cat, items] of Object.entries(grouped)) {
      lines.push(`📂 *${cat}*:`);
      for (const p of items) {
        const price = p.discount_price || p.price;
        const isLow = p.stock_quantity > 0 && p.stock_quantity <= threshold;
        const stockEmoji = p.stock_quantity > 0 ? (isLow ? '⚠️' : '✅') : '❌';
        const stockLabel = p.stock_quantity > 0 ? (isLow ? 'منخفض' : 'متوفر') : 'غير متوفر';
        lines.push(`  ${stockEmoji} ${p.name} — ${price} ${company.symbol} — ${p.stock_quantity} ${p.unit || 'قطعة'} ${stockLabel}`);
        if (p.stock_quantity > 0) totalAvailable++; else totalOut++;
      }
      lines.push('');
    }

    lines.push(`✅ متوفرة: ${totalAvailable} | ❌ غير متوفرة: ${totalOut} | 📦 الإجمالي: ${products.length}`);
    await this.client.sendTypingReply(jid, lines.join('\n'));
  }

  async _cmdLowStock(jid) {
    const threshold = settings.getInt('low_stock_alert', 10);
    const products = db.getProducts().prepare(`
      SELECT p.*, c.name AS category_name
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.is_available = 1 AND p.stock_quantity <= ? AND p.stock_quantity > 0
       ORDER BY p.stock_quantity ASC, p.name ASC
       LIMIT 30
    `).all(threshold);

    if (!products.length) {
      return this.client.sendTypingReply(jid,
        `✅ لا توجد منتجات منخفضة المخزون (الحد: ${threshold} قطعة).`);
    }

    const company = config.company;
    const lines = [`⚠️ *منتجات منخفضة المخزون* (أقل من ${threshold})`, ''];
    for (const p of products) {
      const price = p.discount_price || p.price;
      lines.push(`  ⚠️ ${p.name} — ${price} ${company.symbol} — ${p.stock_quantity} ${p.unit || 'قطعة'} فقط!`);
    }
    lines.push('');
    lines.push(`📦 ${products.length} منتجات تحتاج إعادة تخزين.`);
    await this.client.sendTypingReply(jid, lines.join('\n'));
  }

  async _cmdImportHelp(jid) {
    await this.client.sendTypingReply(jid,
      '📄 *استيراد المنتجات*\n\n' +
      'الرجاء إرسال ملف CSV أو كتابة بيانات المنتجات.\n\n' +
      '*صيغة CSV:*\n' +
      'name, price, category, stock, unit, description\n\n' +
      '*مثال:*\n' +
      'عطر ورد, 150, عطور, 10, قطعة, عطر فاخر\n' +
      'دهن عود, 350, عود, 5, قطعة, دهن عود كمبودي');
  }

  async _handleDocumentImport(jid, supPhone, document) {
    const fileName = (document.fileName || '').toLowerCase();
    if (!fileName.endsWith('.csv')) {
      return this.client.sendTypingReply(jid,
        '⚠️ تنسيق الملف غير مدعوم. الرجاء إرسال ملف CSV.\n' +
        'الأعمدة: name, price, category, stock, unit, description');
    }

    try {
      const response = await fetch(document.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const csvText = await response.text();
      if (!csvText.trim()) {
        return this.client.sendTypingReply(jid, '⚠️ الملف فارغ.');
      }

      await this.client.sendTypingReply(jid, '⏳ جاري تحليل الملف واستيراد المنتجات...');

      let extracted = null;
      try {
        extracted = await AI.askJSON(
          'Extract products from CSV. Return ONLY a JSON array (no explanation). ' +
          'Each object: { "name": "string", "price": 0, "category": "string", ' +
          '"stock": 0, "unit": "قطعة", "description": "" }',
          csvText.substring(0, 3500),
          { maxTokens: 3000, temperature: 0.1, maxRetriesOverride: 2 },
        );
      } catch (err) {
        logger.warn(`AI extraction failed, using raw parse: ${err.message}`);
      }

      const records = (Array.isArray(extracted) && extracted.length)
        ? extracted
        : ImportService.parseCSV(csvText);

      if (!records.length) {
        return this.client.sendTypingReply(jid, '⚠️ لم يتم العثور على منتجات صالحة في الملف.');
      }

      const result = ImportService.importProducts(records, { actor: supPhone });
      await this.client.sendTypingReply(jid,
        `✅ *تم استيراد المنتجات*\n\n` +
        `📦 المضافة: ${result.imported}\n` +
        `🔄 المحدّثة: ${result.updated}\n` +
        `⏭️ المُتخطاة: ${result.skipped}\n` +
        `📄 الملف: ${document.fileName}\n\n` +
        `اكتب *مخزون* لعرض المخزون.`);
      logger.info(`Imported ${result.imported}/${result.updated} products from ${document.fileName}`);
    } catch (err) {
      logger.error(`Import error: ${err.message}`);
      await this.client.sendTypingReply(jid, `❌ فشل استيراد الملف: ${err.message}`);
    }
  }

  async _handleInlineImport(jid, supPhone, data) {
    const records = ImportService.parseCSV(data);
    if (!records.length) {
      return this.client.sendTypingReply(jid,
        '⚠️ تعذر تحليل البيانات. الصيغة:\n' +
        'اسم المنتج, السعر, الفئة, الكمية, الوحدة, الوصف');
    }
    const result = ImportService.importProducts(records, { actor: supPhone });
    await this.client.sendTypingReply(jid,
      `✅ *تم استيراد المنتجات*\n` +
      `📦 المضافة: ${result.imported}\n` +
      `🔄 المحدّثة: ${result.updated}\n` +
      `⏭️ المُتخطاة: ${result.skipped}`);
    logger.info(`Inline import: ${result.imported}/${result.updated} products`);
  }

  async _tryImportCSV(jid, supPhone, text) {
    const records = ImportService.parseCSV(text);
    if (!records.length) return false;
    const result = ImportService.importProducts(records, { actor: supPhone });
    await this.client.sendTypingReply(jid,
      `✅ *تم استيراد ${result.imported + result.updated} منتجات*\n` +
      `(جديدة: ${result.imported}, محدّثة: ${result.updated})\n` +
      `اكتب *مخزون* لعرض المخزون.`);
    return true;
  }

  async _sendHelp(jid) {
    const autoApprove = settings.getBool('auto_approve_orders', false);
    const autoLabel = autoApprove ? '✅ مفعّل' : '❌ معطّل';

    await this.client.sendTypingReply(jid,
      '👋 أهلاً مشرف!\n\n' +
      '*الأوامر المتاحة:*\n' +
      '🔹 *طلبات* — عرض الطلبات المعلقة\n' +
      '🔹 *حالة ORD-xxxxx* — تفاصيل طلب\n' +
      '🔹 *موافقة ORD-xxxxx* — موافقة\n' +
      '🔹 *رفض ORD-xxxxx* [سبب] — رفض\n' +
      '🔹 *تعيين ORD-xxxxx <رقم>* [ملاحظة] — تعيين مندوب\n' +
      '🔹 *توصيل ORD-xxxxx* — بدء التوصيل\n' +
      '🔹 *إنهاء ORD-xxxxx* — إكمال الطلب\n' +
      '🔹 *تلقائي* — تبديل القبول التلقائي (' + autoLabel + ')\n' +
      '🔹 *تقرير* — إحصائيات اليوم\n' +
      '🔹 *تقرير مفصل* — تقرير يومي كامل\n' +
      '🔹 *مخزون* — عرض المخزون\n' +
      '🔹 *ناقص* — منخفضة المخزون\n' +
      '🔹 *استيراد* + ملف CSV — استيراد منتجات');
  }
}

module.exports = SupervisorHandler;
