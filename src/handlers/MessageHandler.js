'use strict';

const db = require('../database/connection');
const config = require('../config/company.config');
const AI = require('../ai/AIService');
const ProductService = require('../services/ProductService');
const CatalogGenerator = require('../generators/CatalogGenerator');
const logger = require('../utils/logger');

const userQueues = new Map();

class MessageHandler {
  constructor(client) {
    this.client = client;
    this.supPhones = new Set(config.supervisors.map((s) => s.phone));

    const company = db.getMain().prepare('SELECT * FROM company_info WHERE id = 1').get();
    AI.setCompany(company);

    // Auto-cancel stale orders every 60 minutes
    const HOUR = 60 * 60 * 1000;
    setInterval(() => this._autoCancelStaleOrders(), HOUR).unref();

    // Scheduled daily report — check every 30 min
    this._lastReportDate = null;
    setInterval(() => this._checkScheduledReport(), 30 * 60 * 1000).unref();
  }

  async handle(event) {
    const { jid } = event;

    const current = userQueues.get(jid) || Promise.resolve();
    let release;
    const next = current.then(() => new Promise((r) => { release = r; }));
    userQueues.set(jid, next);
    await current;

    try {
      await this._process(event);
    } catch (err) {
      logger.error(`Handler error [${jid}]: ${err.message}`);
    } finally {
      release();
      if (userQueues.get(jid) === next) {
        userQueues.delete(jid);
      }
    }
  }

  async _process(event) {
    const { jid, isGroup, text, location, contact, key } = event;
    const senderPn = key?.senderPn || key?.sender_pn || null;
    const phone = this._extractPhone(jid, senderPn);

    const locInfo = location ? ` 📍` : '';
    const contactInfo = contact ? ` 👤` : '';
    logger.info(`📨 [${phone}]${isGroup ? ' (group)' : ''}: ${text || '(non-text)'}${locInfo}${contactInfo}`);

    if (this.supPhones.has(phone)) {
      await this._handleSupervisor(event, phone);
    } else {
      await this._handleCustomer(event, phone);
    }
  }

  async _handleCustomer(event, phone) {
    const { jid, text, location, contact } = event;

    const customer = this._ensureCustomer(phone, jid);
    const conv = this._ensureConversation(customer.id, jid);

    this._saveMessage(conv.id, 'customer', text || '(non-text)', null);

    // If awaiting confirmation, handle yes/no first before any intent classification
    if (text) {
      const convData = db.getMain().prepare('SELECT current_state, state_data FROM conversations WHERE id = ?').get(conv.id);
      if (convData && convData.current_state === 'awaiting_confirmation') {
        const handled = await this._checkConfirmation(jid, conv, phone, text);
        if (handled) return;
      }
      if (convData && convData.current_state === 'awaiting_location') {
        await this._handleLocationInput(jid, conv, phone, text, convData);
        return;
      }
    }

    if (!text) {
      await this._handleNonText(event, conv, phone);
      return;
    }

    const lower = text.trim().toLowerCase();

    if (lower === 'منتجات' || lower === 'المنتجات' || lower === 'عرض المنتجات' || lower === 'catalog') {
      await this._handleCatalogCommand(jid, conv, phone);
      return;
    }

    if (lower === 'فئات' || lower === 'اقسام' || lower === 'categories') {
      await this._handleCategoriesCommand(jid, conv, phone);
      return;
    }

    if (lower === 'اريد' || lower === 'ابي' || lower === 'طلب') {
      await this._handleOrderIntent(jid, conv, phone, text);
      return;
    }

    let intent;
    try {
      intent = await AI.classifyIntent(text);
      logger.info(`  🤖 Intent [${phone}]: ${intent}`);
    } catch (err) {
      logger.warn(`  ⚠️ Intent classification failed: ${err.message}`);
      intent = 'other';
    }

    try {
      switch (intent) {
      case 'greeting':
        await this._handleGreeting(jid, conv, phone);
        break;
      case 'order':
        await this._handleOrderIntent(jid, conv, phone, text);
        break;
      case 'product_inquiry':
      case 'price_inquiry':
        await this._handleInquiryIntent(jid, conv, phone, text);
        break;
      case 'catalog_request':
        await this._handleCatalogCommand(jid, conv, phone);
        break;
      case 'categories_request':
        await this._handleCategoriesCommand(jid, conv, phone);
        break;
      case 'supervisor_request':
        await this._handleSupervisorRequest(jid, conv, phone, text);
        break;
      case 'complaint':
        await this._handleComplaint(jid, conv, phone, text);
        break;
      default:
        await this._handleGeneralReply(jid, conv, phone, text);
      }
    } catch (err) {
      logger.warn(`  ⚠️ Intent handler failed: ${err.message}`);
      await this._replyAndSave(jid, conv,
        `عذراً، أواجه مشكلة تقنية مؤقتة. 🛠️\n` +
        `يمكنك تصفح المنتجات بكتابة *منتجات*\n` +
        `أو التواصل مع مشرف بكتابة *مشرف*`,
      );
    }
  }

  async _handleNonText(event, conv, phone) {
    const { jid, location, contact } = event;

    if (location) {
      // Check if awaiting location — update order with location data
      const convData = db.getMain().prepare('SELECT current_state, state_data FROM conversations WHERE id = ?').get(conv.id);
      if (convData && convData.current_state === 'awaiting_location') {
        await this._handleLocationShare(jid, conv, phone, location, convData);
        return;
      }

      const reply =
        `تم استلام موقعك 📍\n` +
        `📍 الإحداثيات: ${location.latitude}, ${location.longitude}\n` +
        (location.name ? `🏷️ المكان: ${location.name}\n` : '') +
        (location.address ? `📝 العنوان: ${location.address}\n` : '') +
        `\nسنستخدم هذا الموقع لتحديد عنوان التوصيل.\nهل تريد طلب شيء محدد؟ اكتب اسم المنتج أو *منتجات* لعرض الكتالوج.`;
      await this._replyAndSave(jid, conv, reply);
    } else if (contact) {
      const reply =
        `تم استلام معلومات الاتصال 👤\n` +
        `${contact.displayName ? '👤 ' + contact.displayName + '\n' : ''}` +
        `\nكيف يمكنني مساعدتك؟ اكتب *منتجات* لعرض الكتالوج.`;
      await this._replyAndSave(jid, conv, reply);
    } else {
      const reply =
        `أهلاً! لم أتمكن من قراءة هذه الرسالة.\n` +
        `الرجاء إرسال نص أو مشاركة موقعك 📍\n` +
        `اكتب *منتجات* لعرض الكتالوج.`;
      await this._replyAndSave(jid, conv, reply);
    }
  }

  async _handleGreeting(jid, conv, phone) {
    const welcome = config.messages.welcome.replace('{companyName}', config.company.name);

    const categories = ProductService.getAllCategories();
    if (categories.length > 0) {
      const catList = categories.map((c) => `${c.name}`).join(' | ');
      const reply =
        `${welcome}\n\n` +
        `📂 *الفئات المتاحة:*\n${catList}\n\n` +
        `ماذا تريد أن تفعل؟\n` +
        `1️⃣ *منتجات* — عرض كل المنتجات\n` +
        `2️⃣ *فئات* — عرض الفئات\n` +
        `3️⃣ اكتب اسم المنتج للبحث عنه\n` +
        `4️⃣ اكتب طلبك مباشرة (مثال: أريد عطر شانيل ٣ حبات)`;
      await this._replyAndSave(jid, conv, reply);
    } else {
      const reply =
        `${welcome}\n\n` +
        `ماذا تريد أن تفعل؟\n` +
        `1️⃣ *منتجات* — عرض كل المنتجات\n` +
        `2️⃣ اكتب اسم المنتج للبحث عنه\n` +
        `3️⃣ اكتب طلبك مباشرة (مثال: أريد عطر شانيل ٣ حبات)`;
      await this._replyAndSave(jid, conv, reply);
    }
  }

  async _handleCatalogCommand(jid, conv, phone) {
    await this._replyAndSave(jid, conv, '⏳ جاري تجهيز الكتالوج...');

    try {
      const catalog = await CatalogGenerator.generateText();
      await this.client.sendTypingReply(jid, catalog);
      this._saveMessage(conv.id, 'bot', catalog, null);
      logger.info(`✅ Catalog sent to ${phone}`);
    } catch (err) {
      logger.error('Catalog error: ' + err.message);
      await this._replyAndSave(jid, conv, 'عذراً، حدث خطأ في تجهيز الكتالوج. حاول مرة أخرى.');
    }
  }

  async _handleCategoriesCommand(jid, conv, phone) {
    const categories = ProductService.getAllCategories();

    if (!categories.length) {
      await this._replyAndSave(jid, conv,
        'لا توجد فئات حالياً.\nاكتب *منتجات* لعرض كل المنتجات.',
      );
      return;
    }

    const lines = ['📂 *الفئات المتاحة:*', ''];
    for (const c of categories) {
      lines.push(`• ${c.name}${c.name_en ? ' (' + c.name_en + ')' : ''}`);
      if (c.description) lines.push(`  ${c.description}`);
    }
    lines.push('');
    lines.push('اكتب اسم الفئة لعرض منتجاتها.');
    lines.push('اكتب *منتجات* لعرض الكل.');

    await this._replyAndSave(jid, conv, lines.join('\n'));
  }

  async _handleInquiryIntent(jid, conv, phone, text) {
    const extraction = await AI.extractOrder(text);
    const query = extraction?.items?.[0]?.productName || text;

    const results = ProductService.searchAll(query);

    if (!results.length) {
      const categories = ProductService.getAllCategories();
      const catNames = categories.map((c) => c.name).join(' | ');

      let reply = `لم أجد نتائج لـ "${query}".\n\n`;
      reply += `📂 *الفئات:* ${catNames}\n\n`;
      reply += `اكتب *منتجات* لعرض الكتالوج الكامل\n`;
      reply += `أو اكتب اسم منتج آخر للبحث عنه.`;
      await this._replyAndSave(jid, conv, reply);
      return;
    }

    const lines = [`🔍 *نتائج "${query}":*`, ''];
    const company = config.company;

    for (let i = 0; i < results.length; i++) {
      const p = results[i];
      const price = p.discount_price || p.price;
      const stockEmoji = p.stock_quantity > 0 ? '✅' : '❌';

      lines.push(`${i + 1}. *${p.name}*`);
      lines.push(`   💰 ${price} ${company.symbol}`);
      if (p.description) {
        lines.push(`   📝 ${p.description.substring(0, 60)}`);
      }
      lines.push(`   📦 ${stockEmoji} ${p.stock_quantity > 0 ? 'متوفر' : 'غير متوفر'}`);
      lines.push('');
    }

    lines.push('📝 للطلب: اكتب *رقم المنتج* أو *اسمه* مع الكمية المطلوبة.');

    await this._replyAndSave(jid, conv, lines.join('\n'));
  }

  async _handleOrderIntent(jid, conv, phone, text) {
    const extraction = await AI.extractOrder(text);
    const company = config.company;

    if (!extraction || !extraction.hasOrder || !extraction.items?.length) {
      await this._handleGeneralReply(jid, conv, phone, text);
      return;
    }

    const item = extraction.items[0];
    // Search all products including unavailable/out-of-stock
    const results = ProductService.searchAll(item.productName);

    if (!results.length) {
      await this._replyAndSave(jid, conv,
        `لم أجد منتج باسم "${item.productName}".\n\n` +
        `اكتب *منتجات* لعرض القائمة الكاملة\n` +
        `أو اكتب اسم منتج آخر.`,
      );
      return;
    }

    const product = results[0];
    const qty = item.quantity || 1;
    const check = ProductService.checkAvailability(product.id, qty);
    const price = product.discount_price || product.price;
    const total = price * qty;

    if (!check.ok) {
      // Product exists but unavailable or insufficient stock → offer backorder
      const reply =
        `⚠️ ${check.reason}\n\n` +
        `📦 المنتج: *${product.name}*\n` +
        `💰 السعر: ${price} ${company.symbol}\n` +
        `🔢 الكمية المطلوبة: ${qty} ${product.unit || 'قطعة'}\n` +
        `💵 الإجمالي: ${total} ${company.symbol}\n\n` +
        `هل تريد الطلب على أي حال؟ سيتم مراجعة طلبك من المشرف.\n` +
        `اكتب *نعم* للمواصلة أو *لا* للإلغاء.`;

      await this._replyAndSave(jid, conv, reply);

      this._updateConversationState(conv.id, 'awaiting_confirmation', {
        pendingOrder: {
          productId: product.id,
          productName: product.name,
          quantity: qty,
          unitPrice: price,
          total,
          backorder: true,
          reason: check.reason,
        },
      });
      return;
    }

    // Normal available product
    const reply =
      `📝 *تأكيد الطلب:*\n\n` +
      `📦 المنتج: *${product.name}*\n` +
      `🔢 الكمية: ${qty} ${product.unit || 'قطعة'}\n` +
      `💰 السعر: ${price} ${company.symbol}\n` +
      `💵 الإجمالي: ${total} ${company.symbol}\n\n` +
      `هل تؤكد الطلب؟\n` +
      `اكتب *نعم* للتأكيد أو *لا* للإلغاء.`;

    await this._replyAndSave(jid, conv, reply);

    this._updateConversationState(conv.id, 'awaiting_confirmation', {
      pendingOrder: {
        productId: product.id,
        productName: product.name,
        quantity: qty,
        unitPrice: price,
        total,
        backorder: false,
      },
    });
  }

  async _handleComplaint(jid, conv, phone, text) {
    const reply =
      `نأسف جداً لسماع ذلك 💙\n` +
      `سأتأكد من إيصال ملاحظاتك للمشرفين فوراً.\n` +
      `هل هناك شيء يمكنني مساعدتك به الآن؟`;

    await this._replyAndSave(jid, conv, reply);

    for (const sup of config.supervisors) {
      const supJid = this.client.normalizeJid(sup.phone);
      await this.client.sendTypingReply(supJid,
        `⚠️ *شكوى من عميل*\n\n` +
        `📱 العميل: ${this._formatPhoneForDisplay(phone)}\n` +
        `💬 الشكوى: ${text}\n\n` +
        `يرجى التواصل مع العميل.`,
      );
    }
  }

  async _handleSupervisorRequest(jid, conv, phone, text) {
    const reply =
      `سيتواصل معك أحد مندوبينا في أقرب وقت ⏰\n` +
      `أوقات الدوام من 9 صباحاً حتى 9 مساءً 🕘\n\n` +
      `هل هناك شيء عاجل يمكنني مساعدتك به؟\n` +
      `اكتب *منتجات* لعرض الكتالوج.`;

    await this._replyAndSave(jid, conv, reply);

    for (const sup of config.supervisors) {
      const supJid = this.client.normalizeJid(sup.phone);
      await this.client.sendTypingReply(supJid,
        `📥 *طلب تواصل مع مشرف*\n\n` +
        `📱 العميل: ${this._formatPhoneForDisplay(phone)}\n` +
        `💬 الرسالة: ${text}\n\n` +
        `يرجى التواصل مع العميل.`,
      );
    }
  }

  async _handleGeneralReply(jid, conv, phone, text) {
    const lower = text.trim().toLowerCase();

    const confirmationResult = await this._checkConfirmation(jid, conv, phone, lower);
    if (confirmationResult) return;

    try {
      const sessionId = `sess_${phone}_${conv.session_id}`;
      const res = await AI.generateReply(sessionId, text);
      await this._replyAndSave(jid, conv, res.text);
    } catch (err) {
      logger.warn(`  ⚠️ AI reply failed: ${err.message}`);
      await this._replyAndSave(jid, conv,
        `عذراً، أواجه مشكلة تقنية مؤقتة. 🛠️\n` +
        `يمكنك تصفح المنتجات بكتابة *منتجات*\n` +
        `أو التواصل مع مشرف بكتابة *مشرف*`,
      );
    }
  }

  async _checkConfirmation(jid, conv, phone, text) {
    const lower = text.trim().toLowerCase();
    const mdb = db.getMain();
    const convData = mdb.prepare('SELECT current_state, state_data FROM conversations WHERE id = ?').get(conv.id);

    if (!convData || convData.current_state !== 'awaiting_confirmation') return false;

    let stateData = {};
    try { stateData = JSON.parse(convData.state_data || '{}'); } catch {}

    const yes = /^(نعم|yes|ok|اوك|موافق|تمام|يس|اي|اكيد|مؤكد|تأكيد)$/i.test(lower);
    const no = /^(لا|no|إلغاء|الغاء)$/i.test(lower);

    if (!yes && !no) return false;

    if (no) {
      this._updateConversationState(conv.id, 'idle', {});
      await this._replyAndSave(jid, conv,
        '✅ تم إلغاء الطلب.\n\nاكتب *منتجات* لعرض الكتالوج أو اكتب طلبك الجديد.',
      );
      return true;
    }

    const pending = stateData.pendingOrder;
    if (!pending) {
      this._updateConversationState(conv.id, 'idle', {});
      await this._replyAndSave(jid, conv, 'تم إلغاء الطلب. اكتب طلبك الجديد.');
      return true;
    }

    try {
      const company = config.company;
      const isBackorder = pending.backorder;
      const orderStatus = isBackorder ? 'pending_supervisor_approval' : 'pending';

      // Get or ensure customer
      let customer = mdb.prepare('SELECT * FROM customers WHERE phone_number = ?').get(phone);
      if (!customer) {
        mdb.prepare('INSERT INTO customers (phone_number, whatsapp_jid) VALUES (?, ?)').run(phone, jid);
        customer = mdb.prepare('SELECT * FROM customers WHERE phone_number = ?').get(phone);
      }

      // Generate order number
      const orderNumber = this._generateOrderNumber(mdb);

      // Create order
      const orderResult = mdb.prepare(`
        INSERT INTO orders (order_number, customer_id, conversation_id, status, subtotal, total_amount, customer_message)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderNumber,
        customer.id,
        conv.id,
        orderStatus,
        pending.total,
        pending.total,
        `طلب: ${pending.productName} x${pending.quantity}`
      );
      const orderId = orderResult.lastInsertRowid;

      // Create order item
      mdb.prepare(`
        INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderId,
        pending.productId || null,
        pending.productName,
        pending.quantity,
        pending.unitPrice,
        pending.total,
        isBackorder ? 'backorder' : 'pending'
      );

      // Update customer stats
      mdb.prepare(`
        UPDATE customers SET total_orders = total_orders + 1, last_order_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(customer.id);

      // Activity log
      mdb.prepare(`
        INSERT INTO activity_log (action, entity_type, entity_id, user_phone, details)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        'order_created',
        'order',
        orderId,
        phone,
        JSON.stringify({ product: pending.productName, qty: pending.quantity, total: pending.total, backorder: isBackorder })
      );

      this._updateConversationState(conv.id, 'awaiting_location', {
        awaitingLocation: { orderId, orderNumber },
      });

      const backorderNote = isBackorder
        ? `\n⚠️ *ملاحظة:* المنتج غير متوفر حالياً. سيتم مراجعة طلبك من المشرف.\n`
        : '\n';

      await this._replyAndSave(jid, conv,
        `✅ *تم تأكيد طلبك!*\n\n` +
        `🆔 رقم الطلب: *${orderNumber}*\n` +
        `📦 ${pending.productName}\n` +
        `🔢 الكمية: ${pending.quantity}\n` +
        `💰 الإجمالي: ${pending.total} ${company.symbol}\n` +
        backorderNote +
        `\n📍 *الرجاء مشاركة موقعك* لتحديد عنوان التوصيل.\n` +
        `يمكنك إرسال موقعك عبر واتساب 📍 أو كتابة العنوان يدوياً.`,
      );

      for (const sup of config.supervisors) {
        const supJid = this.client.normalizeJid(sup.phone);
        const supMsg = isBackorder
          ? `🛒 *طلب جديد — يحتاج موافقة*\n\n` +
            `🆔 رقم الطلب: ${orderNumber}\n` +
            `📱 العميل: ${this._formatPhoneForDisplay(phone)}\n` +
            `📦 المنتج: ${pending.productName}\n` +
            `🔢 الكمية: ${pending.quantity}\n` +
            `💰 الإجمالي: ${pending.total} ${company.symbol}\n\n` +
            `⚠️ *${pending.reason || 'المنتج غير متوفر'} — طلب مسبق*\n` +
            `للموافقة: *موافقة ${orderNumber}*\n` +
            `للرفض: *رفض ${orderNumber}*`
          : `🛒 *طلب جديد — مؤكد*\n\n` +
            `🆔 رقم الطلب: ${orderNumber}\n` +
            `📱 العميل: ${this._formatPhoneForDisplay(phone)}\n` +
            `📦 المنتج: ${pending.productName}\n` +
            `🔢 الكمية: ${pending.quantity}\n` +
            `💰 الإجمالي: ${pending.total} ${company.symbol}\n\n` +
            `العميل في انتظار التواصل.\n` +
            `للموافقة: *موافقة ${orderNumber}*`;


        await this.client.sendTypingReply(supJid, supMsg);
      }
    } catch (err) {
      logger.error('Order confirmation error: ' + err.message);
      await this._replyAndSave(jid, conv, 'عذراً، حدث خطأ أثناء تسجيل الطلب. سنتواصل معك قريباً.');
    }

    return true;
  }

  async _handleSupervisor(event, phone) {
    const { jid, text, document } = event;

    // Handle document import
    if (document) {
      if (this.supPhones.has(phone)) {
        logger.info(`  📄 Supervisor [${phone}]: importing ${document.fileName}`);
        await this._handleDocumentImport(jid, phone, document);
      }
      return;
    }

    if (!text) return;

    const mdb = db.getMain();
    const lower = text.trim().toLowerCase();

    // /orders — list pending orders
    if (/^(orders|\/orders|طلبات|عرض الطلبات|الطلبات)$/i.test(lower)) {
      logger.info(`  📋 Supervisor [${phone}]: listing orders`);
      await this._cmdOrders(jid, mdb);
      return;
    }

    // /report — detailed report (before stats to match first)
    if (/^(report|\/report|تقرير مفصّل|تقرير مفصل|تقرير كامل)$/i.test(lower)) {
      logger.info(`  📋 Supervisor [${phone}]: detailed report`);
      await this._cmdReport(jid, mdb);
      return;
    }

    // /stats — show today's statistics
    if (/^(stats|\/stats|احصائيات|تقرير|تقرير اليوم)$/i.test(lower)) {
      logger.info(`  📊 Supervisor [${phone}]: viewing stats`);
      await this._cmdStats(jid, mdb);
      return;
    }

    // /stock — show inventory
    if (/^(stock|stocks|\/stock|\/stocks|مخزون|المخزون|جرد)$/i.test(lower)) {
      logger.info(`  📦 Supervisor [${phone}]: viewing stock`);
      await this._cmdStock(jid);
      return;
    }

    // /lowstock — show low stock items
    if (/^(lowstock|\/lowstock|ناقص|منخفض|تنبيه)$/i.test(lower)) {
      logger.info(`  ⚠️ Supervisor [${phone}]: viewing low stock`);
      await this._cmdLowStock(jid);
      return;
    }

    // /approve <order_number>
    const approveMatch = lower.match(/^(approve|\/approve|موافقة)\s+(ord-\d{8}-\d{3})$/i);
    if (approveMatch) {
      const orderNo = approveMatch[2].toUpperCase();
      logger.info(`  ✅ Supervisor [${phone}]: approving ${orderNo}`);
      await this._cmdApprove(jid, phone, orderNo);
      return;
    }

    // /reject <order_number> [reason]
    const rejectMatch = lower.match(/^(reject|\/reject|رفض)\s+(ord-\d{8}-\d{3})(?:\s+(.+))?$/i);
    if (rejectMatch) {
      const orderNo = rejectMatch[2].toUpperCase();
      logger.info(`  ❌ Supervisor [${phone}]: rejecting ${orderNo}`);
      await this._cmdReject(jid, phone, orderNo, rejectMatch[3] || null);
      return;
    }

    // /status <order_number> — view order details
    const statusMatch = lower.match(/^(status|\/status|حالة|تفاصيل)\s+(ord-\d{8}-\d{3})$/i);
    if (statusMatch) {
      const orderNo = statusMatch[2].toUpperCase();
      logger.info(`  🔍 Supervisor [${phone}]: viewing ${orderNo}`);
      await this._cmdStatus(jid, mdb, orderNo);
      return;
    }

    // /deliver <order_number> — mark as in transit
    const deliverMatch = lower.match(/^(deliver|\/deliver|توصيل|شحن)\s+(ord-\d{8}-\d{3})$/i);
    if (deliverMatch) {
      const orderNo = deliverMatch[2].toUpperCase();
      logger.info(`  🚚 Supervisor [${phone}]: delivering ${orderNo}`);
      await this._cmdDeliver(jid, phone, orderNo);
      return;
    }

    // /complete <order_number> — mark as completed
    const completeMatch = lower.match(/^(complete|\/complete|مكتمل|انهاء|إنهاء)\s+(ord-\d{8}-\d{3})$/i);
    if (completeMatch) {
      const orderNo = completeMatch[2].toUpperCase();
      logger.info(`  🏁 Supervisor [${phone}]: completing ${orderNo}`);
      await this._cmdComplete(jid, phone, orderNo);
      return;
    }

    // /assign <order_number> <phone> [notes]
    const assignMatch = lower.match(/^(assign|\/assign|تعيين)\s+(ord-\d{8}-\d{3})\s+(\+\d{7,15}|\d{7,15})(?:\s+(.+))?$/i);
    if (assignMatch) {
      const orderNo = assignMatch[2].toUpperCase();
      const delPhone = assignMatch[3].startsWith('+') ? assignMatch[3] : '+' + assignMatch[3];
      logger.info(`  🚚 Supervisor [${phone}]: assigning ${orderNo} to ${delPhone}`);
      await this._cmdAssign(jid, phone, orderNo, delPhone, assignMatch[4] || null);
      return;
    }

    // /import [data] — import from file or inline data
    const importDataMatch = lower.match(/^(import|\/import|استيراد)\s+(.+)$/i);
    if (importDataMatch) {
      logger.info(`  📄 Supervisor [${phone}]: importing inline`);
      await this._handleInlineImport(jid, importDataMatch[2]);
      return;
    }

    if (/^(import|\/import|استيراد)$/i.test(lower)) {
      await this.client.sendTypingReply(jid,
        `📄 *استيراد المنتجات*\n\n` +
        `الرجاء إرسال ملف CSV أو كتابة بيانات المنتجات.\n\n` +
        `*صيغة CSV:*\n` +
        `name, price, category, stock, unit, description\n\n` +
        `*مثال:*\n` +
        `عطر ورد, 150, عطور, 10, قطعة, عطر فاخر\n` +
        `دهن عود, 350, عود, 5, قطعة, دهن عود كمبودي`,
      );
      return;
    }

    // Partial commands without order number — show usage hint
    if (/^(حالة|موافقة|رفض|توصيل|تعيين|انهاء|إنهاء)$/i.test(lower)) {
      logger.info(`  ℹ️ Supervisor [${phone}]: partial command "${lower}"`);
      await this.client.sendTypingReply(jid,
        `⚠️ الرجاء إدخال رقم الطلب مع الأمر.\n` +
        `مثال: *${lower} ORD-20260515-001*`,
      );
      return;
    }

    // Text might be CSV data (detect by comma count)
    if (text && (text.match(/,/g) || []).length >= 2) {
      logger.info(`  📄 Supervisor [${phone}]: possible CSV data`);
      const result = await this._tryImportCSV(jid, text);
      if (result) return;
    }

    // Default help
    logger.info(`  👋 Supervisor [${phone}]: help`);
    await this.client.sendTypingReply(jid,
      `👋 أهلاً مشرف!\n\n` +
      `*الأوامر المتاحة:*\n` +
      `🔹 *طلبات* — عرض الطلبات المعلقة\n` +
      `🔹 *حالة ORD-xxxxx* — تفاصيل طلب\n` +
      `🔹 *موافقة ORD-xxxxx* — موافقة على طلب\n` +
      `🔹 *رفض ORD-xxxxx* [سبب] — رفض طلب\n` +
      `🔹 *تعيين ORD-xxxxx <رقم>* [ملاحظة] — تعيين مندوب توصيل\n` +
      `🔹 *توصيل ORD-xxxxx* — بدء التوصيل\n` +
      `🔹 *إنهاء ORD-xxxxx* — إكمال الطلب\n` +
      `🔹 *تقرير* — إحصائيات اليوم\n` +
      `🔹 *تقرير مفصل* — تقرير يومي كامل\n` +
      `🔹 *مخزون* — عرض المخزون\n` +
      `🔹 *ناقص* — المنتجات منخفضة المخزون\n` +
      `🔹 *استيراد* + ملف CSV — استيراد منتجات`,
    );
  }

  async _cmdOrders(jid, mdb) {
    const orders = mdb.prepare(`
      SELECT o.*, c.phone_number AS customer_phone, c.name AS customer_name
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.status IN ('pending', 'pending_supervisor_approval')
      ORDER BY o.created_at DESC
      LIMIT 20
    `).all();

    if (!orders.length) {
      await this.client.sendTypingReply(jid, '✅ لا توجد طلبات معلقة.');
      return;
    }

    const company = config.company;
    const lines = ['📋 *الطلبات المعلقة:*', ''];

    for (const o of orders) {
      const statusEmoji = o.status === 'pending_supervisor_approval' ? '🔴' : '🟡';
      const statusLabel = o.status === 'pending_supervisor_approval' ? 'يحتاج موافقة' : 'معلق';
      const item = mdb.prepare(
        'SELECT product_name, quantity, unit_price, subtotal FROM order_items WHERE order_id = ?'
      ).get(o.id);

      lines.push(`${statusEmoji} *${o.order_number}*`);
      lines.push(`   📦 ${item?.product_name || '—'}`);
      lines.push(`   🔢 ${item?.quantity || 0}x × ${item?.unit_price || 0} ${company.symbol}`);
      lines.push(`   💰 ${o.total_amount} ${company.symbol}`);
      lines.push(`   📱 ${this._formatPhoneForDisplay(o.customer_phone)}`);
      lines.push(`   🕐 ${o.created_at}`);
      lines.push(`   ${statusLabel}`);
      lines.push('');
    }

    lines.push('---');
    lines.push('🔹 *موافقة ORD-xxxxx* — موافقة');
    lines.push('🔹 *رفض ORD-xxxxx* — رفض');

    await this.client.sendTypingReply(jid, lines.join('\n'));
  }

  async _cmdApprove(jid, phone, orderNumber) {
    const mdb = db.getMain();

    const order = mdb.prepare(`
      SELECT o.*, c.phone_number, c.whatsapp_jid
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.order_number = ?
    `).get(orderNumber);

    if (!order) {
      await this.client.sendTypingReply(jid, `❌ الطلب ${orderNumber} غير موجود.`);
      return;
    }

    if (order.status === 'cancelled') {
      await this.client.sendTypingReply(jid, `❌ الطلب ${orderNumber} ملغي.`);
      return;
    }

    const newStatus = 'confirmed';
    mdb.prepare(`
      UPDATE orders
      SET status = ?, confirmed_at = CURRENT_TIMESTAMP,
          supervisor_id = (SELECT id FROM supervisors WHERE phone_number = ?)
      WHERE id = ?
    `).run(newStatus, phone, order.id);

    mdb.prepare('UPDATE order_items SET status = \'confirmed\' WHERE order_id = ?').run(order.id);

    mdb.prepare(`
      INSERT INTO activity_log (action, entity_type, entity_id, user_phone, details)
      VALUES (?, ?, ?, ?, ?)
    `).run('order_approved', 'order', order.id, phone, JSON.stringify({ orderNumber }));

    await this.client.sendTypingReply(jid, `✅ تمت الموافقة على الطلب ${orderNumber}.`);

    if (order.whatsapp_jid) {
      try {
        await this.client.sendTypingReply(order.whatsapp_jid,
          `✅ *تمت الموافقة على طلبك!*\n\n` +
          `🆔 رقم الطلب: *${orderNumber}*\n` +
          `سنقوم بتجهيز طلبك والتواصل معك قريباً لتحديد التوصيل 📞`,
        );
      } catch (err) {
        logger.error(`Failed to notify customer for ${orderNumber}: ${err.message}`);
      }
    }
  }

  async _cmdReject(jid, phone, orderNumber, reason) {
    const mdb = db.getMain();

    const order = mdb.prepare(`
      SELECT o.*, c.phone_number, c.whatsapp_jid
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.order_number = ?
    `).get(orderNumber);

    if (!order) {
      await this.client.sendTypingReply(jid, `❌ الطلب ${orderNumber} غير موجود.`);
      return;
    }

    if (order.status === 'cancelled') {
      await this.client.sendTypingReply(jid, `❌ الطلب ${orderNumber} ملغي بالفعل.`);
      return;
    }

    mdb.prepare(`
      UPDATE orders
      SET status = 'cancelled', cancellation_reason = ?, cancelled_at = CURRENT_TIMESTAMP,
          supervisor_id = (SELECT id FROM supervisors WHERE phone_number = ?)
      WHERE id = ?
    `).run(reason || 'تم رفض الطلب من المشرف', phone, order.id);

    mdb.prepare('UPDATE order_items SET status = \'cancelled\' WHERE order_id = ?').run(order.id);

    mdb.prepare(`
      INSERT INTO activity_log (action, entity_type, entity_id, user_phone, details)
      VALUES (?, ?, ?, ?, ?)
    `).run('order_rejected', 'order', order.id, phone, JSON.stringify({ orderNumber, reason }));

    await this.client.sendTypingReply(jid, `❌ تم رفض الطلب ${orderNumber}.`);

    if (order.whatsapp_jid) {
      try {
        const reasonText = reason ? `\n📝 السبب: ${reason}\n` : '\n';
        await this.client.sendTypingReply(order.whatsapp_jid,
          `❌ *نأسف! تم رفض طلبك*\n\n` +
          `🆔 رقم الطلب: *${orderNumber}*\n` +
          reasonText +
          `يمكنك الاطلاع على منتجات أخرى بكتابة *منتجات*\n` +
          `أو التواصل مع خدمة العملاء.`,
        );
      } catch (err) {
        logger.error(`Failed to notify customer for ${orderNumber}: ${err.message}`);
      }
    }
  }

  async _cmdStatus(jid, mdb, orderNumber) {
    const order = mdb.prepare(`
      SELECT o.*, c.phone_number, c.whatsapp_jid, c.name as customer_name
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.order_number = ?
    `).get(orderNumber);

    if (!order) {
      await this.client.sendTypingReply(jid, `❌ الطلب ${orderNumber} غير موجود.`);
      return;
    }

    const company = config.company;
    const items = mdb.prepare(
      'SELECT product_name, quantity, unit_price, subtotal, status FROM order_items WHERE order_id = ?'
    ).all(order.id);

    const lines = [`🔍 *تفاصيل الطلب ${orderNumber}*`, ''];
    lines.push(`📱 العميل: ${this._formatPhoneForDisplay(order.phone_number)}`);
    lines.push(`📌 الحالة: ${this._statusLabel(order.status)}`);
    lines.push('');

    lines.push('📦 *المنتجات:*');
    for (const it of items) {
      lines.push(`   • ${it.product_name} — ${it.quantity}x × ${it.unit_price} ${company.symbol}`);
    }
    lines.push(`💰 الإجمالي: ${order.total_amount} ${company.symbol}`);
    if (order.delivery_address) lines.push(`📍 العنوان: ${order.delivery_address}`);
    if (order.delivery_phone) lines.push(`🚚 مندوب التوصيل: ${order.delivery_phone}`);
    if (order.delivery_notes) lines.push(`📝 ملاحظات التوصيل: ${order.delivery_notes}`);
    if (order.customer_message) lines.push(`💬 رسالة العميل: ${order.customer_message}`);
    if (order.cancellation_reason) lines.push(`📝 سبب الإلغاء: ${order.cancellation_reason}`);
    lines.push(`🕐 أنشئ: ${order.created_at}`);

    await this.client.sendTypingReply(jid, lines.join('\n'));
  }

  async _cmdDeliver(jid, phone, orderNumber) {
    const mdb = db.getMain();
    const order = mdb.prepare(`
      SELECT o.*, c.whatsapp_jid FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.order_number = ?
    `).get(orderNumber);

    if (!order) {
      await this.client.sendTypingReply(jid, `❌ الطلب ${orderNumber} غير موجود.`);
      return;
    }
    if (order.status === 'cancelled') {
      await this.client.sendTypingReply(jid, `❌ الطلب ${orderNumber} ملغي.`);
      return;
    }

    mdb.prepare(`UPDATE orders SET status = 'in_transit' WHERE id = ?`).run(order.id);
    mdb.prepare(`INSERT INTO activity_log (action, entity_type, entity_id, user_phone, details) VALUES (?, ?, ?, ?, ?)`)
      .run('order_delivering', 'order', order.id, phone, JSON.stringify({ orderNumber }));

    await this.client.sendTypingReply(jid, `🚚 تم تحديث الطلب ${orderNumber} — قيد التوصيل.`);

    if (order.whatsapp_jid) {
      try {
        await this.client.sendTypingReply(order.whatsapp_jid,
          `🚚 *طلبك ${orderNumber} في الطريق!*\n\n` +
          `سيصلك مندوب التوصيل قريباً 📞`,
        );
      } catch (err) {
        logger.error(`Notify error ${orderNumber}: ${err.message}`);
      }
    }
  }

  async _cmdComplete(jid, phone, orderNumber) {
    const mdb = db.getMain();
    const order = mdb.prepare(`
      SELECT o.*, c.whatsapp_jid FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.order_number = ?
    `).get(orderNumber);

    if (!order) {
      await this.client.sendTypingReply(jid, `❌ الطلب ${orderNumber} غير موجود.`);
      return;
    }
    if (order.status === 'cancelled') {
      await this.client.sendTypingReply(jid, `❌ الطلب ${orderNumber} ملغي.`);
      return;
    }

    mdb.prepare(`UPDATE orders SET status = 'completed', delivered_at = CURRENT_TIMESTAMP WHERE id = ?`).run(order.id);
    mdb.prepare(`UPDATE order_items SET status = 'delivered' WHERE order_id = ?`).run(order.id);
    mdb.prepare(`INSERT INTO activity_log (action, entity_type, entity_id, user_phone, details) VALUES (?, ?, ?, ?, ?)`)
      .run('order_completed', 'order', order.id, phone, JSON.stringify({ orderNumber }));

    await this.client.sendTypingReply(jid, `🏁 تم إكمال الطلب ${orderNumber}.`);

    if (order.whatsapp_jid) {
      try {
        await this.client.sendTypingReply(order.whatsapp_jid,
          `🏁 *تم إكمال طلبك ${orderNumber}!*\n\n` +
          `نشكرك على ثقتك 🌹\n` +
          `يسعدنا خدمتك دائماً.`,
        );
      } catch (err) {
        logger.error(`Notify error ${orderNumber}: ${err.message}`);
      }
    }
  }

  _statusLabel(status) {
    const labels = {
      pending: 'معلق',
      pending_supervisor_approval: 'بانتظار موافقة المشرف',
      confirmed: 'مؤكد',
      in_transit: 'قيد التوصيل',
      delivered: 'تم التوصيل',
      completed: 'مكتمل',
      cancelled: 'ملغي',
    };
    return labels[status] || status;
  }

  async _cmdStats(jid, mdb) {
    const company = config.company;

    const today = mdb.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('pending', 'pending_supervisor_approval') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status IN ('confirmed', 'in_transit', 'delivered', 'completed') THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
        COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total_amount ELSE 0 END), 0) AS revenue
      FROM orders WHERE date(created_at) = date('now')
    `).get();

    const pdb = db.getProducts();
    const inv = pdb.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN stock_quantity > 0 THEN 1 ELSE 0 END) AS available,
        SUM(CASE WHEN stock_quantity = 0 THEN 1 ELSE 0 END) AS out_of_stock,
        SUM(CASE WHEN stock_quantity > 0 AND stock_quantity <= (SELECT CAST(value AS INTEGER) FROM main.system_settings WHERE key = 'low_stock_alert') THEN 1 ELSE 0 END) AS low
      FROM products WHERE is_available = 1
    `).get();

    await this.client.sendTypingReply(jid,
      `📊 *التقرير*\n\n` +
      `🛒 الطلبات\n` +
      `  إجمالي: ${today.total || 0}\n` +
      `  معلقة: ${today.pending || 0}\n` +
      `  مؤكدة: ${today.active || 0}\n` +
      `  ملغية: ${today.cancelled || 0}\n` +
      `💰 الإيرادات: ${today.revenue} ${company.symbol}\n\n` +
      `📦 المخزون\n` +
      `  إجمالي: ${inv.total || 0}\n` +
      `  متوفرة: ${inv.available || 0}\n` +
      `  ⚠️ منخفضة: ${inv.low || 0}\n` +
      `  ❌ غير متوفرة: ${inv.out_of_stock || 0}`,
    );
  }

  async _handleLocationShare(jid, conv, phone, location, convData) {
    const mdb = db.getMain();
    let stateData = {};
    try { stateData = JSON.parse(convData.state_data || '{}'); } catch {}

    const { orderId, orderNumber } = stateData.awaitingLocation || {};
    if (!orderId) {
      this._updateConversationState(conv.id, 'idle', {});
      await this._replyAndSave(jid, conv, 'تم استلام موقعك. شكراً!');
      return;
    }

    const address = location.address || location.name || `${location.latitude}, ${location.longitude}`;

    mdb.prepare(`
      UPDATE orders
      SET delivery_lat = ?, delivery_lng = ?, delivery_address = ?,
          status = CASE WHEN status = 'pending_supervisor_approval' THEN status ELSE 'location_collected' END
      WHERE id = ?
    `).run(location.latitude, location.longitude, address, orderId);

    mdb.prepare(`
      INSERT INTO activity_log (action, entity_type, entity_id, user_phone, details)
      VALUES (?, ?, ?, ?, ?)
    `).run('location_received', 'order', orderId, phone,
      JSON.stringify({ orderNumber, lat: location.latitude, lng: location.longitude, address }));

    this._updateConversationState(conv.id, 'idle', {});

    await this._replyAndSave(jid, conv,
      `📍 *تم استلام موقعك بنجاح!*\n` +
      `🆔 الطلب: *${orderNumber}*\n` +
      `🗺️ ${address}\n\n` +
      `سنقوم بتجهيز طلبك والتواصل معك قريباً 📞`,
    );

    logger.info(`📍 Location saved for order ${orderNumber}`);
  }

  async _handleLocationInput(jid, conv, phone, text, convData) {
    const mdb = db.getMain();
    let stateData = {};
    try { stateData = JSON.parse(convData.state_data || '{}'); } catch {}

    const { orderId, orderNumber } = stateData.awaitingLocation || {};
    if (!orderId) {
      this._updateConversationState(conv.id, 'idle', {});
      return;
    }

    const address = text.trim();
    if (!address || address.length < 3) {
      await this._replyAndSave(jid, conv,
        '📍 الرجاء إرسال عنوان صحيح أو مشاركة موقعك عبر واتساب.',
      );
      return;
    }

    mdb.prepare(`
      UPDATE orders
      SET delivery_address = ?,
          status = CASE WHEN status = 'pending_supervisor_approval' THEN status ELSE 'location_collected' END
      WHERE id = ?
    `).run(address, orderId);

    mdb.prepare(`
      INSERT INTO activity_log (action, entity_type, entity_id, user_phone, details)
      VALUES (?, ?, ?, ?, ?)
    `).run('location_received', 'order', orderId, phone,
      JSON.stringify({ orderNumber, address }));

    this._updateConversationState(conv.id, 'idle', {});

    await this._replyAndSave(jid, conv,
      `📍 *تم استلام عنوانك بنجاح!*\n` +
      `🆔 الطلب: *${orderNumber}*\n` +
      `📝 ${address}\n\n` +
      `سنقوم بتجهيز طلبك والتواصل معك قريباً 📞`,
    );

    logger.info(`📍 Address saved for order ${orderNumber}`);
  }

  async _handleDocumentImport(jid, phone, document) {
    const fileName = document.fileName.toLowerCase();
    if (!fileName.endsWith('.csv')) {
      await this.client.sendTypingReply(jid,
        `⚠️ تنسيق الملف غير مدعوم.\n` +
        `الرجاء إرسال ملف CSV فقط.\n` +
        `أعمدة الملف المقترحة: name, price, category, stock, unit, description`,
      );
      return;
    }

    try {
      const response = await fetch(document.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const csvText = await response.text();

      if (!csvText.trim()) {
        await this.client.sendTypingReply(jid, '⚠️ الملف فارغ.');
        return;
      }

      await this.client.sendTypingReply(jid, '⏳ جاري تحليل الملف واستيراد المنتجات...');

      // Try AI extraction first, fall back to raw parse
      let extracted;
      try {
        extracted = await AI.askJSON(
          `Extract products from CSV. Return ONLY a JSON array (no explanation). Each object: { "name": "string", "price": 0, "category": "string", "stock": 0, "unit": "قطعة", "description": "" }`,
          csvText.substring(0, 3500),
          { maxTokens: 3000, temperature: 0.1, maxRetriesOverride: 2 }
        );
      } catch (err) {
        logger.warn(`AI extraction failed, using raw parse: ${err.message}`);
      }

      if (!Array.isArray(extracted) || !extracted.length) {
        // Fallback: raw CSV parse
        extracted = this._parseCSV(csvText).map((p) => ({
          name: p.name || p[0] || '',
          price: parseFloat(p.price || p[1]) || 0,
          category: p.category || p[2] || 'عام',
          stock: parseInt(p.stock || p[3]) || 0,
          unit: p.unit || p[4] || 'قطعة',
          description: p.description || p[5] || '',
        }));
      }

      if (!extracted.length) {
        await this.client.sendTypingReply(jid, '⚠️ لم يتم العثور على منتجات صالحة في الملف.');
        return;
      }

      const pdb = db.getProducts();
      let imported = 0;
      let skipped = 0;

      pdb.transaction(() => {
        for (const item of extracted) {
          const name = (item.name || '').trim();
          if (!name) { skipped++; continue; }

          const categoryName = item.category || 'عام';
          let catRow = pdb.prepare(
            'SELECT id FROM categories WHERE name = ? OR name_en = ?'
          ).get(categoryName, categoryName);

          if (!catRow) {
            const catResult = pdb.prepare(
              'INSERT INTO categories (name, is_active) VALUES (?, 1)'
            ).run(categoryName);
            catRow = { id: catResult.lastInsertRowid };
          }

          const existing = pdb.prepare('SELECT id FROM products WHERE name = ?').get(name);
          const price = parseFloat(item.price) || 0;
          const stock = parseInt(item.stock) || 0;
          const unit = item.unit || 'قطعة';
          const desc = item.description || '';

          if (existing) {
            pdb.prepare(`
              UPDATE products SET price = ?, description = ?, stock_quantity = ?, unit = ?, is_available = 1
              WHERE id = ?
            `).run(price, desc, stock, unit, existing.id);
          } else {
            pdb.prepare(`
              INSERT INTO products (category_id, name, price, description, stock_quantity, unit, is_available)
              VALUES (?, ?, ?, ?, ?, ?, 1)
            `).run(catRow.id, name, price, desc, stock, unit);
          }
          imported++;
        }
      })();

      await this.client.sendTypingReply(jid,
        `✅ *تم استيراد المنتجات*\n\n` +
        `📦 المستوردة: ${imported}\n` +
        `⏭️ المُتخطاة: ${skipped}\n` +
        `📄 الملف: ${document.fileName}\n\n` +
        `اكتب *مخزون* لعرض المخزون.`,
      );

      logger.info(`📄 Imported ${imported} products from ${document.fileName}`);
    } catch (err) {
      logger.error(`Import error: ${err.message}`);
      await this.client.sendTypingReply(jid, `❌ فشل استيراد الملف: ${err.message}`);
    }
  }

  async _tryImportCSV(jid, text) {
    const csvText = text.replace(/\\n/g, '\n');
    const products = this._parseCSV(csvText);
    if (!products.length || products.every(p => !(p.name || p[0]))) {
      return false;
    }

    const pdb = db.getProducts();
    let imported = 0;

    pdb.transaction(() => {
      for (const p of products) {
        const name = (p.name || p[0] || '').trim();
        if (!name) continue;

        const catName = p.category || p[2] || 'عام';
        let catRow = pdb.prepare('SELECT id FROM categories WHERE name = ? OR name_en = ?').get(catName, catName);
        if (!catRow) {
          const r = pdb.prepare('INSERT INTO categories (name, is_active) VALUES (?, 1)').run(catName);
          catRow = { id: r.lastInsertRowid };
        }

        const price = parseFloat(p.price || p[1]) || 0;
        const stock = parseInt(p.stock || p[3]) || 0;
        const unit = p.unit || p[4] || 'قطعة';
        const desc = p.description || p[5] || '';

        const existing = pdb.prepare('SELECT id FROM products WHERE name = ?').get(name);
        if (existing) {
          pdb.prepare('UPDATE products SET price=?, description=?, stock_quantity=?, unit=?, is_available=1 WHERE id=?')
            .run(price, desc, stock, unit, existing.id);
        } else {
          pdb.prepare('INSERT INTO products (category_id,name,price,description,stock_quantity,unit,is_available) VALUES (?,?,?,?,?,?,1)')
            .run(catRow.id, name, price, desc, stock, unit);
        }
        imported++;
      }
    })();

    await this.client.sendTypingReply(jid,
      `✅ *تم استيراد ${imported} منتجات*\n` +
      `اكتب *مخزون* لعرض المخزون.`,
    );
    return true;
  }

  _parseCSV(text) {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];

    const parseLine = (line) => {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      result.push(current.trim());
      return result;
    };

    const headers = parseLine(lines[0]);
    const products = [];
    for (let i = 1; i < lines.length; i++) {
      const values = parseLine(lines[i]);
      if (values.length === 0 || values.every((v) => !v)) continue;
      const product = {};
      for (let j = 0; j < headers.length; j++) {
        product[headers[j].toLowerCase().trim()] = values[j] || '';
      }
      products.push(product);
    }
    return products;
  }

  async _cmdReport(jid, mdb) {
    const company = config.company;
    const pdb = db.getProducts();
    const threshold = this._getLowStockThreshold();

    // Orders today
    const orders = mdb.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total_amount END), 0) AS revenue,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN status IN ('pending', 'pending_supervisor_approval') THEN 1 ELSE 0 END) AS pending
      FROM orders WHERE date(created_at) = date('now')
    `).get();

    // Top products
    const topProducts = pdb.prepare(`
      SELECT name, total_sold, stock_quantity FROM products
      WHERE total_sold > 0 ORDER BY total_sold DESC LIMIT 5
    `).all();

    // Low stock
    const lowStock = pdb.prepare(`
      SELECT COUNT(*) AS count FROM products
      WHERE is_available = 1 AND stock_quantity > 0 AND stock_quantity <= ?
    `).get(threshold);

    // New customers today
    const newCustomers = mdb.prepare(`
      SELECT COUNT(*) AS count FROM customers WHERE date(created_at) = date('now')
    `).get();

    // Inventory
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
    lines.push('');

    if (topProducts.length) {
      lines.push('⭐ *الأكثر مبيعاً*');
      for (const p of topProducts) {
        lines.push(`  • ${p.name} — ${p.total_sold} مباع — ${p.stock_quantity} متبقي`);
      }
    }

    await this.client.sendTypingReply(jid, lines.join('\n'));
  }

  _getLowStockThreshold() {
    const mdb = db.getMain();
    const row = mdb.prepare('SELECT value FROM system_settings WHERE key = ?').get('low_stock_alert');
    return row ? parseInt(row.value) || 10 : 10;
  }

  async _cmdLowStock(jid) {
    const pdb = db.getProducts();
    const threshold = this._getLowStockThreshold();
    const products = pdb.prepare(`
      SELECT p.*, c.name AS category_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.is_available = 1 AND p.stock_quantity <= ? AND p.stock_quantity > 0
      ORDER BY p.stock_quantity ASC, p.name ASC
      LIMIT 30
    `).all(threshold);

    if (!products.length) {
      await this.client.sendTypingReply(jid, `✅ لا توجد منتجات منخفضة المخزون (الحد: ${threshold} قطعة).`);
      return;
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

  async _cmdStock(jid) {
    const pdb = db.getProducts();
    const products = pdb.prepare(`
      SELECT p.*, c.name AS category_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ORDER BY c.sort_order, p.name
    `).all();

    if (!products.length) {
      await this.client.sendTypingReply(jid, '📦 المخزون فارغ حالياً.');
      return;
    }

    const company = config.company;
    const grouped = {};
    for (const p of products) {
      const cat = p.category_name || 'بدون فئة';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(p);
    }

    const lines = ['📦 *المخزون*', ''];
    let totalAvailable = 0;
    let totalOut = 0;

    for (const [cat, items] of Object.entries(grouped)) {
      lines.push(`📂 *${cat}*:`);
      for (const p of items) {
        const price = p.discount_price || p.price;
        const threshold = this._getLowStockThreshold();
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

  async _handleInlineImport(jid, data) {
    const csvText = data.replace(/\\n/g, '\n');
    const products = this._parseCSV(csvText);
    
    if (!products.length) {
      await this.client.sendTypingReply(jid,
        '⚠️ تعذر تحليل البيانات. تأكد من الصيغة:\n' +
        'اسم المنتج, السعر, الفئة, الكمية, الوحدة, الوصف',
      );
      return;
    }

    const pdb = db.getProducts();
    let imported = 0;
    let skipped = 0;

    pdb.transaction(() => {
      for (const p of products) {
        const name = (p.name || p[0] || '').trim();
        if (!name) { skipped++; continue; }

        const catName = p.category || p[2] || 'عام';
        let catRow = pdb.prepare('SELECT id FROM categories WHERE name = ? OR name_en = ?').get(catName, catName);
        if (!catRow) {
          const r = pdb.prepare('INSERT INTO categories (name, is_active) VALUES (?, 1)').run(catName);
          catRow = { id: r.lastInsertRowid };
        }

        const price = parseFloat(p.price || p[1]) || 0;
        const stock = parseInt(p.stock || p[3]) || 0;
        const unit = p.unit || p[4] || 'قطعة';
        const desc = p.description || p[5] || '';

        const existing = pdb.prepare('SELECT id FROM products WHERE name = ?').get(name);
        if (existing) {
          pdb.prepare('UPDATE products SET price = ?, description = ?, stock_quantity = ?, unit = ?, is_available = 1 WHERE id = ?')
            .run(price, desc, stock, unit, existing.id);
        } else {
          pdb.prepare('INSERT INTO products (category_id, name, price, description, stock_quantity, unit, is_available) VALUES (?, ?, ?, ?, ?, ?, 1)')
            .run(catRow.id, name, price, desc, stock, unit);
        }
        imported++;
      }
    })();

    await this.client.sendTypingReply(jid,
      `✅ *تم استيراد المنتجات*\n` +
      `📦 المستوردة: ${imported}\n` +
      `⏭️ المُتخطاة: ${skipped}`,
    );

    logger.info(`📄 Inline import: ${imported} products`);
  }

  _autoCancelStaleOrders() {
    const mdb = db.getMain();
    const hours = config.orders.autoCancelHours || 24;
    const result = mdb.prepare(`
      UPDATE orders SET status = 'cancelled', cancellation_reason = ?, cancelled_at = CURRENT_TIMESTAMP
      WHERE status IN ('pending', 'pending_supervisor_approval')
        AND created_at < datetime('now', '-' || ? || ' hours')
    `).run(`إلغاء تلقائي بعد ${hours} ساعة`, hours);

    if (result.changes > 0) {
      logger.info(`🕐 Auto-cancelled ${result.changes} stale orders (${hours}h)`);
    }
  }

  _checkScheduledReport() {
    const mdb = db.getMain();
    const today = new Date().toISOString().slice(0, 10);
    if (this._lastReportDate === today) return;

    const row = mdb.prepare('SELECT value FROM system_settings WHERE key = ?').get('working_hours_end');
    const endTime = row?.value || '22:00';
    const now = new Date();
    const [eh, em] = endTime.split(':').map(Number);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), eh, em);
    if (now < end) return;

    this._lastReportDate = today;
    this._sendDailyReportToSupervisors();
  }

  _sendDailyReportToSupervisors() {
    const mdb = db.getMain();
    const pdb = db.getProducts();
    const company = config.company;

    const orders = mdb.prepare(`
      SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total_amount END), 0) AS revenue,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM orders WHERE date(created_at) = date('now')
    `).get();

    const lowCount = pdb.prepare(`
      SELECT COUNT(*) AS c FROM products WHERE is_available = 1 AND stock_quantity > 0 AND stock_quantity <= ?
    `).get(this._getLowStockThreshold());

    const lines = [
      `🌙 *تقرير نهاية اليوم — ${company.name}*`,
      '',
      `🛒 الطلبات: ${orders.total || 0} | ✅ مكتملة: ${orders.completed || 0}`,
      `💰 الإيرادات: ${orders.revenue || 0} ${company.symbol}`,
      `⚠️ منخفضة المخزون: ${lowCount?.c || 0}`,
      '',
      `اكتب *تقرير مفصل* للتفاصيل الكاملة.`,
    ];

    for (const sup of config.supervisors) {
      const supJid = this.client.normalizeJid(sup.phone);
      this.client.sendTypingReply(supJid, lines.join('\n')).catch(() => {});
    }

    logger.info(`📊 Daily report sent to ${config.supervisors.length} supervisors`);
  }

  _ensureCustomer(phone, jid) {
    const mdb = db.getMain();
    let customer = mdb.prepare('SELECT * FROM customers WHERE phone_number = ?').get(phone);
    if (!customer) {
      mdb.prepare(
        'INSERT INTO customers (phone_number, whatsapp_jid) VALUES (?, ?)',
      ).run(phone, jid);
      customer = mdb.prepare('SELECT * FROM customers WHERE phone_number = ?').get(phone);
      logger.info(`  🆕 New customer: ${phone}`);
    }
    return customer;
  }

  _ensureConversation(customerId, jid) {
    const mdb = db.getMain();
    const today = new Date().toISOString().slice(0, 10);
    const sessionId = `sess_${customerId}_${today}`;

    let conv = mdb.prepare(
      'SELECT * FROM conversations WHERE session_id = ?',
    ).get(sessionId);

    if (!conv) {
      mdb.prepare(`
        INSERT INTO conversations (customer_id, whatsapp_jid, session_id)
        VALUES (?, ?, ?)
      `).run(customerId, jid, sessionId);
      conv = mdb.prepare(
        'SELECT * FROM conversations WHERE session_id = ?',
      ).get(sessionId);
    }

    return conv;
  }

  _saveMessage(convId, senderType, text, aiResponse) {
    const result = db.getMain().prepare(`
      INSERT INTO messages (conversation_id, sender_type, message_text, ai_response)
      VALUES (?, ?, ?, ?)
    `).run(convId, senderType, text, aiResponse || null);
    return result.lastInsertRowid;
  }

  async _replyAndSave(jid, conv, reply) {
    const sent = await this.client.sendTypingReply(jid, reply);
    const msgId = this._saveMessage(conv.id, 'bot', reply, null);

    const whatsappMsgId = sent?.key?.id || null;
    if (whatsappMsgId) {
      db.getMain().prepare(
        'UPDATE messages SET whatsapp_msg_id = ? WHERE id = ?',
      ).run(whatsappMsgId, msgId);
    }

    logger.info(`✅ Replied [${this._extractPhone(jid)}]: ${reply.substring(0, 60)}...`);
  }

  _updateConversationState(convId, state, data) {
    db.getMain().prepare(`
      UPDATE conversations
      SET current_state = ?, state_data = ?, last_message_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(state, JSON.stringify(data), convId);
  }

  _extractPhone(jid, senderPn) {
    const raw = (jid || '').trim();
    if (raw.includes('@s.whatsapp.net')) {
      return raw.replace('@s.whatsapp.net', '');
    }
    if (raw.includes('@lid')) {
      if (senderPn) {
        return senderPn.replace('@s.whatsapp.net', '');
      }
      return 'lid:' + raw.replace('@lid', '');
    }
    return raw;
  }

  _generateOrderNumber(mdb) {
    const prefix = config.orders.orderPrefix || 'ORD';
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const count = mdb.prepare(`
      SELECT COUNT(*) as count FROM orders WHERE date(created_at) = date('now')
    `).get();
    const seq = (count.count + 1).toString().padStart(3, '0');
    return `${prefix}-${today}-${seq}`;
  }

  _formatPhoneForDisplay(phone) {
    if (phone.startsWith('lid:')) return phone;
    const digits = phone.replace(/\D/g, '');
    if (digits.length >= 12) {
      const cc = digits.slice(0, 3);
      const rest = digits.slice(3);
      return `+${cc} ${rest.slice(0, 3)} ${rest.slice(3)}`;
    }
    if (digits.length >= 9) {
      return `+${digits}`;
    }
    return phone;
  }

  isSupervisorPhone(phone) {
    return this.supPhones.has(phone);
  }
}

module.exports = MessageHandler;
