'use strict';

const settings = require('./settings');

/**
 * Conservative input sanitization for free-text messages. Keeps unicode
 * (Arabic), trims, normalizes whitespace, strips zero-width / control chars
 * that are commonly used in spoofing.
 */
function sanitizeText(input) {
  if (input == null) return '';
  let s = String(input);

  // Strip C0 / C1 controls except common whitespace (tab, LF, CR).
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');

  // Strip zero-width / format chars commonly abused for spoofing.
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');

  // Collapse runs of whitespace, but keep newlines so multi-line orders work.
  s = s.replace(/[ \t]+/g, ' ').replace(/\r\n?/g, '\n');

  return s.trim();
}

/**
 * Validate inbound text length against the configured cap. Returns
 * { ok, reason } so the caller can reply to the user.
 */
function validateMessageLength(text) {
  const max = settings.getInt('max_message_length', 4000);
  if (!text) return { ok: true };
  if (text.length > max) {
    return { ok: false, reason: `Message exceeds ${max} characters` };
  }
  return { ok: true };
}

function clampQuantity(qty, max) {
  const cap = max || settings.getInt('max_order_qty', 100);
  const n = Math.max(1, Math.min(cap, parseInt(qty, 10) || 1));
  return n;
}

module.exports = { sanitizeText, validateMessageLength, clampQuantity };
