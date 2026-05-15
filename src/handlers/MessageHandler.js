'use strict';

const config = require('../config/company.config');
const db = require('../database/connection');
const logger = require('../utils/logger');
const AI = require('../ai/AIService');

const MessageQueue = require('../utils/MessageQueue');
const phoneUtil = require('../utils/phone');
const sanitize = require('../utils/sanitize');

const RateLimiter = require('../services/RateLimiter');
const Idempotency = require('../services/IdempotencyService');

const CustomerHandler = require('./CustomerHandler');
const SupervisorHandler = require('./SupervisorHandler');

/**
 * MessageHandler — thin router.
 *
 * Responsibilities:
 *   1. Idempotency: drop redelivered WhatsApp messages.
 *   2. Sanitization & length cap on inbound text.
 *   3. Rate limit per sender phone.
 *   4. Serialize messages from the same JID via MessageQueue.
 *   5. Dispatch to CustomerHandler / SupervisorHandler.
 */
class MessageHandler {
  constructor(client) {
    this.client = client;
    this.supPhones = new Set((config.supervisors || []).map((s) => s.phone));
    this.queue = new MessageQueue();

    // Seed AI with company info now that the DB is ready.
    try {
      const company = db.getMain().prepare(
        'SELECT * FROM company_info WHERE id = 1'
      ).get();
      if (company) AI.setCompany(company);
    } catch (err) {
      logger.warn(`Failed to seed AI company: ${err.message}`);
    }

    this.customer = new CustomerHandler(client);
    this.supervisor = new SupervisorHandler(client);
  }

  isSupervisorPhone(phone) {
    return this.supPhones.has(phone);
  }

  async handle(event) {
    const { jid, key, text } = event;

    // ── 1. Idempotency ────────────────────────────────────────────────
    const messageId = key?.id;
    if (messageId && !Idempotency.acquire(messageId)) {
      logger.info(`Dropping duplicate message ${messageId}`);
      return;
    }

    // ── 2. Sanitization & length validation ───────────────────────────
    if (text) {
      event.text = sanitize.sanitizeText(text);
      const lengthCheck = sanitize.validateMessageLength(event.text);
      if (!lengthCheck.ok) {
        await this.client.sendTypingReply(jid,
          'الرسالة طويلة جداً. الرجاء تقصيرها وإعادة الإرسال.'
        ).catch(() => {});
        return;
      }
    }

    // ── 3. Resolve phone (handle @lid) ────────────────────────────────
    const senderPn = key?.senderPn || key?.sender_pn || null;
    const phone = phoneUtil.extractPhone(jid, senderPn);

    // ── 4. Rate limit (skip for supervisors so ops aren't blocked) ────
    if (!this.supPhones.has(phone) && !event.isGroup) {
      const rl = RateLimiter.check(phone);
      if (!rl.allowed) {
        await this.client.sendTypingReply(jid,
          'لقد أرسلت رسائل كثيرة. يرجى الانتظار قليلاً ثم المحاولة مجدداً.'
        ).catch(() => {});
        return;
      }
    }

    // ── 5. Serialize per-JID and dispatch ─────────────────────────────
    return this.queue.run(jid, async () => {
      try {
        const locationInfo = event.location ? ' 📍' : '';
        const contactInfo = event.contact ? ' 👤' : '';
        const groupInfo = event.isGroup ? ' (group)' : '';
        logger.info(`📨 [${phone}]${groupInfo}: ${event.text || '(non-text)'}${locationInfo}${contactInfo}`);

        if (this.supPhones.has(phone)) {
          await this.supervisor.handle(event, phone);
        } else {
          await this.customer.handle(event, phone);
        }
      } catch (err) {
        logger.error(`Handler error [${phone}]: ${err.stack || err.message}`);
      }
    });
  }

  shutdown() {
    this.queue.shutdown();
  }
}

module.exports = MessageHandler;
