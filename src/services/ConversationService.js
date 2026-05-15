'use strict';

const db = require('../database/connection');
const { CONVERSATION_STATE } = require('../utils/constants');

class ConversationService {
  ensure(customerId, jid) {
    const mdb = db.getMain();
    const today = new Date().toISOString().slice(0, 10);
    const sessionId = `sess_${customerId}_${today}`;

    let conv = mdb.prepare(
      'SELECT * FROM conversations WHERE session_id = ?'
    ).get(sessionId);

    if (!conv) {
      mdb.prepare(`
        INSERT INTO conversations (customer_id, whatsapp_jid, session_id)
        VALUES (?, ?, ?)
      `).run(customerId, jid, sessionId);
      conv = mdb.prepare(
        'SELECT * FROM conversations WHERE session_id = ?'
      ).get(sessionId);
    }
    return conv;
  }

  getById(convId) {
    return db.getMain().prepare(
      'SELECT id, customer_id, whatsapp_jid, session_id, current_state, state_data FROM conversations WHERE id = ?'
    ).get(convId);
  }

  setState(convId, state, data = {}) {
    db.getMain().prepare(`
      UPDATE conversations
         SET current_state   = ?,
             state_data      = ?,
             last_message_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(state, JSON.stringify(data), convId);
  }

  resetState(convId) {
    this.setState(convId, CONVERSATION_STATE.IDLE, {});
  }

  parseStateData(conv) {
    try { return JSON.parse(conv.state_data || '{}'); } catch (_) { return {}; }
  }

  saveMessage(convId, senderType, text, aiResponse) {
    const result = db.getMain().prepare(`
      INSERT INTO messages (conversation_id, sender_type, message_text, ai_response)
      VALUES (?, ?, ?, ?)
    `).run(convId, senderType, text, aiResponse || null);
    return result.lastInsertRowid;
  }

  attachWhatsappMsgId(messageId, whatsappMsgId) {
    if (!whatsappMsgId) return;
    db.getMain().prepare(
      'UPDATE messages SET whatsapp_msg_id = ? WHERE id = ?'
    ).run(whatsappMsgId, messageId);
  }
}

module.exports = new ConversationService();
