'use strict';

const logger = require('./logger');

/**
 * Domain-specific error classes that carry a stable code and a
 * user-safe Arabic message. Handlers should `instanceof` check these
 * to decide whether to reply with the message verbatim or fall back
 * to a generic apology.
 */
class DomainError extends Error {
  constructor(code, userMessage, meta = {}) {
    super(userMessage);
    this.name = 'DomainError';
    this.code = code;
    this.userMessage = userMessage;
    this.meta = meta;
  }
}

class RateLimitError extends DomainError {
  constructor(retryAfter) {
    super('RATE_LIMITED',
      'لقد أرسلت رسائل كثيرة 🛑\nيرجى الانتظار قليلاً ثم المحاولة مجدداً.',
      { retryAfter });
  }
}

class ValidationError extends DomainError {
  constructor(field, userMessage) {
    super('VALIDATION_ERROR', userMessage, { field });
  }
}

class StockError extends DomainError {
  constructor(productName, requested, available) {
    super(
      'OUT_OF_STOCK',
      `الكمية المتاحة من "${productName}" هي ${available} فقط، وقد طُلب ${requested}.`,
      { productName, requested, available },
    );
  }
}

/**
 * Install global handlers. We never want the bot to die from an
 * unhandled rejection inside a single message — log it and keep going.
 */
function installGlobalHandlers() {
  process.on('unhandledRejection', (reason) => {
    const msg = reason && reason.stack ? reason.stack : String(reason);
    logger.error('UNHANDLED REJECTION: ' + msg);
  });

  process.on('uncaughtException', (err) => {
    logger.error('UNCAUGHT EXCEPTION: ' + (err && err.stack ? err.stack : String(err)));
    // Stay alive: WhatsApp connection is still useful even after one bug.
  });
}

module.exports = {
  DomainError, RateLimitError, ValidationError, StockError,
  installGlobalHandlers,
};
