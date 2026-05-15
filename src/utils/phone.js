'use strict';

/**
 * Phone / JID utilities.
 *
 * WhatsApp Business now exposes two flavors of recipient identifiers:
 *   - "@s.whatsapp.net" (real phone-number JID)
 *   - "@lid" (linked-id, opaque, used in many group/community scenarios)
 *
 * For lid-based JIDs Baileys often surfaces the underlying phone via
 * `key.senderPn`. We always try to resolve to a real phone when possible.
 */

function extractPhone(jid, senderPn) {
  const raw = (jid || '').toString().trim();

  if (raw.endsWith('@s.whatsapp.net')) {
    return raw.replace('@s.whatsapp.net', '');
  }

  if (raw.endsWith('@lid')) {
    if (senderPn) {
      return senderPn.replace('@s.whatsapp.net', '');
    }
    return 'lid:' + raw.replace('@lid', '');
  }

  if (raw.endsWith('@g.us')) {
    return raw; // group JID — return as-is
  }

  return raw;
}

function normalizeJid(phone) {
  if (!phone) return phone;
  if (phone.toString().includes('@')) return phone;
  return phone.toString().replace(/^\+/, '') + '@s.whatsapp.net';
}

function formatForDisplay(phone) {
  if (!phone) return '';
  const str = phone.toString();
  if (str.startsWith('lid:')) return str;

  const digits = str.replace(/\D/g, '');
  if (digits.length >= 12) {
    const cc = digits.slice(0, 3);
    const rest = digits.slice(3);
    return `+${cc} ${rest.slice(0, 3)} ${rest.slice(3)}`;
  }
  if (digits.length >= 9) {
    return `+${digits}`;
  }
  return str;
}

module.exports = { extractPhone, normalizeJid, formatForDisplay };
