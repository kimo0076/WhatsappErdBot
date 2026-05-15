'use strict';

const db = require('../database/connection');

class CustomerService {
  /**
   * Find or create a customer keyed by phone number. Idempotent.
   */
  ensure(phone, jid) {
    const mdb = db.getMain();
    let customer = mdb.prepare(
      'SELECT * FROM customers WHERE phone_number = ?'
    ).get(phone);

    if (customer) {
      // Keep JID in sync if it changed (the customer may have re-linked WA).
      if (jid && jid !== customer.whatsapp_jid) {
        mdb.prepare(
          'UPDATE customers SET whatsapp_jid = ? WHERE id = ?'
        ).run(jid, customer.id);
        customer.whatsapp_jid = jid;
      }
      return customer;
    }

    mdb.prepare(
      'INSERT INTO customers (phone_number, whatsapp_jid) VALUES (?, ?)'
    ).run(phone, jid);

    return mdb.prepare('SELECT * FROM customers WHERE phone_number = ?').get(phone);
  }

  getById(id) {
    return db.getMain().prepare('SELECT * FROM customers WHERE id = ?').get(id);
  }

  bumpAfterOrder(customerId, total) {
    db.getMain().prepare(`
      UPDATE customers
         SET total_orders  = COALESCE(total_orders, 0) + 1,
             total_spent   = COALESCE(total_spent, 0) + ?,
             last_order_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(total || 0, customerId);
  }
}

module.exports = new CustomerService();
