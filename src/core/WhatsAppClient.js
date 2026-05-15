'use strict';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const ANTI_BAN_CONFIG = {
  minTypingDelay: 1500,
  maxTypingDelay: 4000,
  browser: ['WhatsApp Bot', 'Chrome', '114.0.0'],
  maxReconnectAttempts: 5,
  reconnectDelay: 3000,
};

let reconnectCount = 0;

function randomDelay(min, max) {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min),
  );
}

const baileysLogger = pino({
  level: process.env.LOG_LEVEL || 'silent',
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

function extractText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.documentMessage?.caption ||
    ''
  );
}

function extractLocation(message) {
  const loc = message?.locationMessage;
  if (!loc) return null;
  return {
    latitude: loc.degreesLatitude,
    longitude: loc.degreesLongitude,
    name: loc.name || null,
    address: loc.address || null,
    mapsUrl: `https://maps.google.com/?q=${loc.degreesLatitude},${loc.degreesLongitude}`,
  };
}

function extractContact(message) {
  const contact = message?.contactMessage;
  if (!contact) return null;
  return {
    displayName: contact.displayName || null,
    vcard: contact.vcard || null,
  };
}

function extractDocument(message) {
  const doc = message?.documentMessage;
  if (!doc) return null;
  return {
    fileName: doc.fileName || '',
    mimetype: doc.mimetype || '',
    url: doc.url || '',
    fileLength: doc.fileLength || 0,
  };
}

class WhatsAppClient {
  constructor() {
    this.sock = null;
    this.authFolder = path.join(process.cwd(), process.env.WA_SESSION_PATH || './data/auth_info');
    this.messageHandler = null;
  }

  async sendTypingReply(jid, text) {
    try {
      await this.sock.sendPresenceUpdate('composing', jid);
      const delay = Math.min(
        ANTI_BAN_CONFIG.minTypingDelay + text.length * 30,
        ANTI_BAN_CONFIG.maxTypingDelay,
      );
      await randomDelay(ANTI_BAN_CONFIG.minTypingDelay, delay);
      const result = await this.sock.sendMessage(jid, { text });
      await this.sock.sendPresenceUpdate('available', jid);
      return result;
    } catch (err) {
      logger.error('Send error: ' + err.message);
      return null;
    }
  }

  async sendLocation(jid, latitude, longitude) {
    try {
      return await this.sock.sendMessage(jid, {
        location: { degreesLatitude: latitude, degreesLongitude: longitude },
      });
    } catch (err) {
      logger.error('Send location error: ' + err.message);
      return null;
    }
  }

  async connect(handleMessage) {
    if (!fs.existsSync(this.authFolder)) {
      fs.mkdirSync(this.authFolder, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
    const { version } = await fetchLatestBaileysVersion();

    logger.info(`WhatsApp connecting... Baileys v${version.join('.')}`);

    this.sock = makeWASocket({
      version,
      logger: baileysLogger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      browser: ANTI_BAN_CONFIG.browser,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
      retryRequestDelayMs: 2000,
      maxMsgRetryCount: 3,
    });

    this.sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log('\n📱 Scan QR Code to login:\n');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn(`Connection closed (status ${statusCode}). Reconnect: ${shouldReconnect}`);

        if (shouldReconnect && reconnectCount < ANTI_BAN_CONFIG.maxReconnectAttempts) {
          reconnectCount++;
          setTimeout(() => this.connect(handleMessage), ANTI_BAN_CONFIG.reconnectDelay);
        } else if (!shouldReconnect) {
          logger.warn('Logged out. Delete auth_info/ and restart.');
        }
      }

      if (connection === 'open') {
        reconnectCount = 0;
        logger.info('✅ WhatsApp connected.');
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.processedMessageIds = new Set();

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;

        // Skip duplicate messages (Baileys retries after decryption failures)
        if (this.processedMessageIds.has(msg.key.id)) continue;
        this.processedMessageIds.add(msg.key.id);
        if (this.processedMessageIds.size > 1000) {
          const first = this.processedMessageIds.values().next().value;
          this.processedMessageIds.delete(first);
        }

        const jid = msg.key.remoteJid;
        const userId = jidNormalizedUser(jid);
        const isGroup = jid.endsWith('@g.us');

        const text = extractText(msg.message);
        const location = extractLocation(msg.message);
        const contact = extractContact(msg.message);
        const document = extractDocument(msg.message);

        const event = {
          jid,
          userId,
          isGroup,
          text: text.trim(),
          location,
          contact,
          document,
          rawMessage: msg.message,
          key: msg.key,
        };

        try {
          await handleMessage(event);
        } catch (err) {
          baileysLogger.error({ err }, 'message dispatch error');
        }
      }
    });

    return this.sock;
  }

  normalizeJid(phone) {
    if (phone.includes('@')) return phone;
    return phone + '@s.whatsapp.net';
  }
}

module.exports = WhatsAppClient;
