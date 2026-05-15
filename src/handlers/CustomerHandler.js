'use strict';

const config = require('../config/company.config');
const logger = require('../utils/logger');
const AI = require('../ai/AIService');
const ProductService = require('../services/ProductService');
const CatalogGenerator = require('../generators/CatalogGenerator');
const Order = require('../services/OrderService');
const Customer = require('../services/CustomerService');
const Conversation = require('../services/ConversationService');
const phoneUtil = require('../utils/phone');
const sanitize = require('../utils/sanitize');
const {
  ORDER_STATUS,
  CONVERSATION_STATE,
  SENDER_TYPE,
} = require('../utils/constants');
const { StockError } = require('../utils/errors');

const YES_PATTERN = /^(نعم|yes|ok|اوك|أوك|موافق|تمام|يس|اي|أي|اكيد|أكيد|مؤكد|تأكيد|ايوه|أيوه)$/i;
const NO_PATTERN = /^(لا|no|إلغاء|الغاء|كانسل|cancel)$/i;

class CustomerHandler {
  constructor(client) {
    this.client = client;
  }

  async handle(event, phone) {
    const { jid, text, location, contact } = event;

    const customer = Customer.ensure(phone, jid);
    const conv = Conversation.ensure(customer.id, jid);

    Conversation.saveMessage(conv.id, SENDER_TYPE.CUSTOMER, text || '(non-text)', null);

    // Handle in-flight states FIRST so confirmation/location aren't
    // misinterpreted as a fresh intent.
    if (text) {
      const fresh = Conversation.getById(conv.id);
      if (fresh.current_state === CONVERSATION_STATE.AWAITING_CONFIRMATION) {
        const handled = await this._maybeHandleConfirmation(jid, conv, phone, text, fresh);
        if (handled) return;
      }
      if (fresh.current_state === CONVERSATION_STATE.AWAITING_LOCATION) {
        await this._handleLocationInput(jid, conv, phone, text, fresh);
        return;
      }
    }

    if (!text) {
      await this._handleNonText(event, conv, phone);
      return;
    }

    const lower = text.trim().toLowerCase();

    if (this._matches(lower, ['منتجات', 'المنتجات', 'عرض المنتجات', 'catalog'])) {
      return this._sendCatalog(jid, conv, phone);
    }
    if (this._matches(lower, ['فئات', 'اقسام', 'الفئات', 'categories'])) {
      return this._sendCategories(jid, conv);
    }
    if (this._matches(lower, ['اريد', 'أريد', 'ابي', 'أبي', 'طلب'])) {
      return this._handleOrderIntent(jid, conv, phone, text);
    }

    let intent;
    try {
      intent = await AI.classifyIntent(text);
      logger.info(`  Intent [${phone}]: ${intent}`);
    } catch (err) {
      logger.warn(`Intent classification failed: ${err.message}`);
      intent = 'other';
    }

    try {
      switch (intent) {
        case 'greeting':            return this._handleGreeting(jid, conv);
        case 'order':               return this._handleOrderIntent(jid, conv, phone, text);
        case 'product_inquiry':
        case 'price_inquiry':       return this._handleInquiry(jid, conv, text);
        case 'catalog_request':     return this._sendCatalog(jid, conv, phone);
        case 'categories_request':  return this._sendCategories(jid, conv);
        case 'supervisor_request':  return this._handleSupervisorRequest(jid, conv, phone, text);
        case 'complaint':           return this._handleComplaint(jid, conv, phone, text);
        default:                    return this._handleGeneralReply(jid, conv, phone, text);
      }
    } catch (err) {
      logger.error(`Customer flow error: ${err.message}`);
      await this._reply(jid, conv,
        'عذراً، أواجه مشكلة تقنية مؤقتة.\n' +
        'يمكنك تصفح المنتجات بكتابة *منتجات* أو التواصل مع مشرف بكتابة *مشرف*');
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Specific intents
  // ────────────────────────────────────────────────────────────────────

  async _handleNonText(event, conv, phone) {
    const { jid, location, contact } = event;

    if (location) {
      const fresh = Conversation.getById(conv.id);
      if (fresh.current_state === CONVERSATION_STATE.AWAITING_LOCATION) {
        await this._handleLocationShare(jid, conv, phone, location, fresh);
        return;
      }
      await this._reply(jid, conv,
        'تم استلام موقعك 📍\n' +
        `الإحداثيات: ${location.latitude}, ${location.longitude}\n` +
        (location.name ? `المكان: ${location.name}\n` : '') +
        (location.address ? `العنوان: ${location.address}\n` : '') +
        '\nاكتب اسم المنتج أو *منتجات* لعرض الكتالوج.');
      return;
    }

    if (contact) {
      await this._reply(jid, conv,
        'تم استلام معلومات الاتصال.\n' +
        (contact.displayName ? `الاسم: ${contact.displayName}\n` : '') +
        '\nكيف يمكنني مساعدتك؟ اكتب *منتجات*.');
      return;
    }

    await this._reply(jid, conv,
      'لم أتمكن من قراءة هذه الرسالة. الرجاء إرسال نص أو موقع.\n' +
      'اكتب *منتجات* لعرض الكتالوج.');
  }

  async _handleGreeting(jid, conv) {
    const welcome = (config.messages?.welcome || 'مرحباً بك في {companyName}!')
      .replace('{companyName}', config.company.name);

    const categories = ProductService.getAllCategories();
    const catLine = categories.length
      ? `\n📂 *الفئات المتاحة:* ${categories.map((c) => c.name).join(' | ')}\n`
      : '\n';

    const reply =
      `${welcome}\n${catLine}\n` +
      'ماذا تريد أن تفعل؟\n' +
      '1️⃣ *منتجات* — عرض كل المنتجات\n' +
      '2️⃣ *فئات* — عرض الفئات\n' +
      '3️⃣ اكتب اسم المنتج للبحث عنه\n' +
      '4️⃣ اكتب طلبك مباشرة (مثال: أريد عطر شانيل ٣ حبات)';

    await this._reply(jid, conv, reply);
  }

  async _sendCatalog(jid, conv, phone) {
    await this._reply(jid, conv, 'جاري تجهيز الكتالوج...');
    try {
      const catalog = await CatalogGenerator.generateText();
      await this.client.sendTypingReply(jid, catalog);
      Conversation.saveMessage(conv.id, SENDER_TYPE.BOT, catalog, null);
      logger.info(`Catalog sent to ${phone}`);
    } catch (err) {
      logger.error('Catalog error: ' + err.message);
      await this._reply(jid, conv, 'عذراً، حدث خطأ في تجهيز الكتالوج. حاول مرة أخرى.');
    }
  }

  async _sendCategories(jid, conv) {
    const categories = ProductService.getAllCategories();
    if (!categories.length) {
      return this._reply(jid, conv,
        'لا توجد فئات حالياً.\nاكتب *منتجات* لعرض كل المنتجات.');
    }

    const lines = ['📂 *الفئات المتاحة:*', ''];
    for (const c of categories) {
      lines.push(`• ${c.name}${c.name_en ? ' (' + c.name_en + ')' : ''}`);
      if (c.description) lines.push(`  ${c.description}`);
    }
    lines.push('');
    lines.push('اكتب اسم الفئة لعرض منتجاتها، أو *منتجات* للكل.');
    await this._reply(jid, conv, lines.join('\n'));
  }

  async _handleInquiry(jid, conv, text) {
    const extraction = await AI.extractOrder(text);
    const query = extraction?.items?.[0]?.productName || text;
    const results = ProductService.searchAll(query);

    if (!results.length) {
      const cats = ProductService.getAllCategories().map((c) => c.name).join(' | ');
      return this._reply(jid, conv,
        `لم أجد نتائج لـ "${query}".\n\n` +
        (cats ? `📂 *الفئات:* ${cats}\n\n` : '') +
        'اكتب *منتجات* لعرض الكتالوج، أو اسم منتج آخر للبحث.');
    }

    const lines = [`🔍 *نتائج "${query}":*`, ''];
    const company = config.company;
    results.forEach((p, i) => {
      const price = p.discount_price || p.price;
      const stockEmoji = p.stock_quantity > 0 ? '✅' : '❌';
      lines.push(`${i + 1}. *${p.name}*`);
      lines.push(`   💰 ${price} ${company.symbol}`);
      if (p.description) lines.push(`   📝 ${p.description.substring(0, 60)}`);
      lines.push(`   📦 ${stockEmoji} ${p.stock_quantity > 0 ? 'متوفر' : 'غير متوفر'}`);
      lines.push('');
    });
    lines.push('للطلب: اكتب *اسم المنتج* مع الكمية المطلوبة.');
    await this._reply(jid, conv, lines.join('\n'));
  }

  async _handleOrderIntent(jid, conv, phone, text) {
    const extraction = await AI.extractOrder(text);
    if (!extraction || !extraction.hasOrder || !Array.isArray(extraction.items) || !extraction.items.length) {
      return this._handleGeneralReply(jid, conv, phone, text);
    }

    const company = config.company;
    const resolved = [];
    const unresolved = [];

    for (const raw of extraction.items) {
      if (!raw.productName) continue;
      const qty = sanitize.clampQuantity(raw.quantity || 1);
      const product = ProductService.bestMatch(raw.productName);
      if (!product) {
        unresolved.push({ name: raw.productName, qty });
        continue;
      }
      resolved.push({
        product,
        quantity: qty,
        unitPrice: product.discount_price || product.price,
      });
    }

    if (!resolved.length) {
      return this._reply(jid, conv,
        'لم أجد المنتجات التي ذكرتها.\n' +
        'اكتب *منتجات* لعرض الكتالوج أو اكتب اسم المنتج بدقة.');
    }

    // Aggregate by product (customer might have repeated the same item).
    const aggregate = new Map();
    for (const r of resolved) {
      const key = r.product.id;
      if (aggregate.has(key)) {
        aggregate.get(key).quantity += r.quantity;
      } else {
        aggregate.set(key, { ...r });
      }
    }
    const items = [...aggregate.values()];

    let total = 0;
    let anyBackorder = false;
    const reasons = [];

    for (const it of items) {
      const check = ProductService.checkAvailability(it.product.id, it.quantity);
      it.backorder = !check.ok;
      if (!check.ok) {
        anyBackorder = true;
        reasons.push(`${it.product.name}: ${check.reason}`);
      }
      it.subtotal = +(it.unitPrice * it.quantity).toFixed(2);
      total += it.subtotal;
    }
    total = +total.toFixed(2);

    // Build summary message.
    const lines = ['📝 *تأكيد الطلب:*', ''];
    items.forEach((it, idx) => {
      const flag = it.backorder ? ' ⚠️ غير متوفر' : '';
      lines.push(
        `${idx + 1}. *${it.product.name}* — ${it.quantity} ${it.product.unit || 'قطعة'} × ${it.unitPrice} = ${it.subtotal} ${company.symbol}${flag}`
      );
    });
    if (unresolved.length) {
      lines.push('');
      lines.push('⚠️ *لم أتعرف على هذه العناصر:*');
      unresolved.forEach((u) => lines.push(`  • ${u.name}`));
    }
    lines.push('');
    lines.push(`💵 *الإجمالي: ${total} ${company.symbol}*`);
    if (anyBackorder) {
      lines.push('');
      lines.push('⚠️ بعض العناصر غير متوفرة حالياً وستحتاج موافقة المشرف.');
      reasons.forEach((r) => lines.push(`  • ${r}`));
    }
    lines.push('');
    lines.push('هل تؤكد الطلب؟ اكتب *نعم* أو *لا*.');

    await this._reply(jid, conv, lines.join('\n'));

    Conversation.setState(conv.id, CONVERSATION_STATE.AWAITING_CONFIRMATION, {
      pendingOrder: {
        items: items.map((it) => ({
          productId: it.product.id,
          productName: it.product.name,
          productSku: it.product.sku || null,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          backorder: it.backorder,
        })),
        total,
        backorder: anyBackorder,
        reasons,
      },
    });
  }

  async _maybeHandleConfirmation(jid, conv, phone, text, fresh) {
    const lower = text.trim().toLowerCase();
    const yes = YES_PATTERN.test(lower);
    const no = NO_PATTERN.test(lower);
    if (!yes && !no) return false;

    const stateData = Conversation.parseStateData(fresh);
    const pending = stateData.pendingOrder;

    if (no) {
      Conversation.resetState(conv.id);
      await this._reply(jid, conv,
        '✅ تم إلغاء الطلب.\n\nاكتب *منتجات* لعرض الكتالوج أو اكتب طلبك الجديد.');
      return true;
    }

    if (!pending || !Array.isArray(pending.items) || !pending.items.length) {
      Conversation.resetState(conv.id);
      await this._reply(jid, conv, 'تم إلغاء الطلب. اكتب طلبك الجديد.');
      return true;
    }

    try {
      const result = Order.create({
        customerId: fresh.customer_id,
        customerPhone: phone,
        conversationId: conv.id,
        items: pending.items,
        customerMessage: text,
        backorder: pending.backorder,
      });

      Conversation.setState(conv.id, CONVERSATION_STATE.AWAITING_LOCATION, {
        awaitingLocation: {
          orderId: result.order.id,
          orderNumber: result.order.order_number,
        },
      });

      await this._sendOrderConfirmation(jid, conv, result.order, result.items, pending.backorder);
      await this._notifySupervisorsNewOrder(result.order, result.items, pending);
    } catch (err) {
      Conversation.resetState(conv.id);
      logger.error('Order creation failed: ' + err.message);
      if (err.code === 'OUT_OF_STOCK') {
        const stockErr = new StockError(err.productName, err.requested, err.available);
        await this._reply(jid, conv, stockErr.userMessage);
      } else {
        await this._reply(jid, conv,
          'عذراً، حدث خطأ أثناء تسجيل الطلب. سنتواصل معك قريباً.');
      }
    }
    return true;
  }

  async _sendOrderConfirmation(jid, conv, order, items, isBackorder) {
    const company = config.company;
    const lines = ['✅ *تم تأكيد طلبك!*', ''];
    lines.push(`🆔 رقم الطلب: *${order.order_number}*`);
    lines.push('');
    items.forEach((it, idx) => {
      lines.push(`${idx + 1}. ${it.product_name} — ${it.quantity} × ${it.unit_price} = ${it.subtotal} ${company.symbol}`);
    });
    lines.push('');
    lines.push(`💰 الإجمالي: ${order.total_amount} ${company.symbol}`);
    if (isBackorder) {
      lines.push('');
      lines.push('⚠️ بعض العناصر غير متوفرة. سيتم مراجعة طلبك من المشرف.');
    }
    lines.push('');
    lines.push('📍 *الرجاء مشاركة موقعك* لتحديد عنوان التوصيل.');
    lines.push('يمكنك إرسال موقعك عبر واتساب أو كتابة العنوان يدوياً.');

    await this._reply(jid, conv, lines.join('\n'));
  }

  async _notifySupervisorsNewOrder(order, items, pending) {
    const company = config.company;
    const summary = items
      .map((it) => `  • ${it.product_name} — ${it.quantity} × ${it.unit_price} ${company.symbol}`)
      .join('\n');

    const isBackorder = order.status === ORDER_STATUS.PENDING_APPROVAL;
    const header = isBackorder
      ? '🛒 *طلب جديد — يحتاج موافقة*'
      : '🛒 *طلب جديد — مؤكد*';

    const lines = [
      header,
      '',
      `🆔 رقم الطلب: ${order.order_number}`,
      `📱 العميل: ${phoneUtil.formatForDisplay(order.phone_number || order.customer_phone || '')}`,
      '',
      summary,
      '',
      `💰 الإجمالي: ${order.total_amount} ${company.symbol}`,
    ];
    if (isBackorder && pending?.reasons?.length) {
      lines.push('');
      lines.push('⚠️ ملاحظات:');
      pending.reasons.forEach((r) => lines.push(`  • ${r}`));
    }
    lines.push('');
    lines.push(`للموافقة: *موافقة ${order.order_number}*`);
    lines.push(`للرفض: *رفض ${order.order_number}*`);

    for (const sup of config.supervisors || []) {
      const supJid = phoneUtil.normalizeJid(sup.phone);
      this.client.sendTypingReply(supJid, lines.join('\n'))
        .catch((err) => logger.warn(`Supervisor notify ${sup.phone} failed: ${err.message}`));
    }
  }

  async _handleLocationShare(jid, conv, phone, location, fresh) {
    const stateData = Conversation.parseStateData(fresh);
    const { orderId, orderNumber } = stateData.awaitingLocation || {};
    if (!orderId) {
      Conversation.resetState(conv.id);
      return this._reply(jid, conv, 'تم استلام موقعك. شكراً!');
    }

    const address = location.address || location.name
      || `${location.latitude}, ${location.longitude}`;
    Order.attachLocation(orderId, {
      latitude: location.latitude,
      longitude: location.longitude,
      address,
    }, phone);

    Conversation.resetState(conv.id);

    await this._reply(jid, conv,
      `📍 *تم استلام موقعك بنجاح!*\n` +
      `🆔 الطلب: *${orderNumber}*\n` +
      `🗺️ ${address}\n\n` +
      `سنقوم بتجهيز طلبك والتواصل معك قريباً.`);

    logger.info(`Location saved for order ${orderNumber}`);
  }

  async _handleLocationInput(jid, conv, phone, text, fresh) {
    const stateData = Conversation.parseStateData(fresh);
    const { orderId, orderNumber } = stateData.awaitingLocation || {};
    if (!orderId) {
      Conversation.resetState(conv.id);
      return;
    }

    const address = text.trim();
    if (!address || address.length < 3) {
      return this._reply(jid, conv,
        '📍 الرجاء إرسال عنوان صحيح أو مشاركة موقعك عبر واتساب.');
    }

    Order.attachLocation(orderId, { address }, phone);
    Conversation.resetState(conv.id);

    await this._reply(jid, conv,
      `📍 *تم استلام عنوانك بنجاح!*\n` +
      `🆔 الطلب: *${orderNumber}*\n` +
      `📝 ${address}\n\n` +
      `سنقوم بتجهيز طلبك والتواصل معك قريباً.`);
    logger.info(`Address saved for order ${orderNumber}`);
  }

  async _handleComplaint(jid, conv, phone, text) {
    await this._reply(jid, conv,
      'نأسف جداً لسماع ذلك 💙\nسأتأكد من إيصال ملاحظاتك للمشرفين فوراً.\nهل هناك شيء يمكنني مساعدتك به الآن؟');

    for (const sup of config.supervisors || []) {
      const supJid = phoneUtil.normalizeJid(sup.phone);
      this.client.sendTypingReply(supJid,
        '⚠️ *شكوى من عميل*\n' +
        `📱 العميل: ${phoneUtil.formatForDisplay(phone)}\n` +
        `💬 الشكوى: ${text}\n` +
        'يرجى التواصل مع العميل.'
      ).catch(() => {});
    }
  }

  async _handleSupervisorRequest(jid, conv, phone, text) {
    await this._reply(jid, conv,
      'سيتواصل معك أحد مندوبينا في أقرب وقت.\n' +
      'أوقات الدوام من 9 صباحاً حتى 9 مساءً.\n' +
      'هل هناك شيء عاجل يمكنني مساعدتك به؟ اكتب *منتجات* لعرض الكتالوج.');

    for (const sup of config.supervisors || []) {
      const supJid = phoneUtil.normalizeJid(sup.phone);
      this.client.sendTypingReply(supJid,
        '📥 *طلب تواصل مع مشرف*\n' +
        `📱 العميل: ${phoneUtil.formatForDisplay(phone)}\n` +
        `💬 الرسالة: ${text}\n` +
        'يرجى التواصل مع العميل.'
      ).catch(() => {});
    }
  }

  async _handleGeneralReply(jid, conv, phone, text) {
    try {
      const sessionId = `sess_${phone}_${conv.session_id}`;
      const res = await AI.generateReply(sessionId, text);
      await this._reply(jid, conv, res.text);
    } catch (err) {
      logger.warn(`AI reply failed: ${err.message}`);
      await this._reply(jid, conv,
        'عذراً، أواجه مشكلة تقنية مؤقتة.\n' +
        'يمكنك تصفح المنتجات بكتابة *منتجات*\n' +
        'أو التواصل مع مشرف بكتابة *مشرف*');
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────

  _matches(lower, list) {
    return list.some((kw) => lower === kw);
  }

  async _reply(jid, conv, text) {
    const sent = await this.client.sendTypingReply(jid, text);
    const messageId = Conversation.saveMessage(conv.id, SENDER_TYPE.BOT, text, null);
    Conversation.attachWhatsappMsgId(messageId, sent?.key?.id);
    logger.info(`Replied [${conv.whatsapp_jid}]: ${text.substring(0, 60).replace(/\n/g, ' ')}…`);
  }
}

module.exports = CustomerHandler;
