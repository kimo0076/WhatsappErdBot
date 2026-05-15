'use strict';

const EventEmitter = require('events');

/**
 * Domain Event Bus
 * ────────────────
 * In-process pub/sub for decoupling domain logic from side effects.
 *
 * Events flow: OrderService → EventBus → (notifications, analytics, audit, ...)
 *
 * Usage:
 *   const bus = require('./EventBus');
 *   bus.emit(events.ORDER_CREATED, { orderId: 1, tenant: 'perfumes' });
 *   bus.on(events.ORDER_CREATED, (payload) => { ... });
 */

const EVENTS = Object.freeze({
  ORDER_CREATED: 'order:created',
  ORDER_CONFIRMED: 'order:confirmed',
  ORDER_REJECTED: 'order:rejected',
  ORDER_CANCELLED: 'order:cancelled',
  ORDER_IN_TRANSIT: 'order:in_transit',
  ORDER_DELIVERED: 'order:delivered',
  ORDER_COMPLETED: 'order:completed',
  ORDER_LOCATION_RECEIVED: 'order:location_received',
  ORDER_DELIVERY_ASSIGNED: 'order:delivery_assigned',
  STOCK_LOW: 'stock:low',
  STOCK_OUT: 'stock:out',
  STOCK_CHANGED: 'stock:changed',
  PRODUCT_IMPORTED: 'product:imported',
  PRODUCT_UPDATED: 'product:updated',
  CUSTOMER_REGISTERED: 'customer:registered',
  CONVERSATION_STARTED: 'conversation:started',
  DAILY_REPORT_READY: 'report:daily_ready',
});

class DomainEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this._stats = new Map();

    // Track event counts
    this.on('newListener', (event) => {
      if (!this._stats.has(event)) {
        this._stats.set(event, { emitted: 0, listeners: 0 });
      }
      const s = this._stats.get(event);
      s.listeners = this.listenerCount(event);
    });
  }

  emit(event, payload) {
    const enriched = {
      ...payload,
      _timestamp: new Date().toISOString(),
      _event: event,
    };

    // Update stats
    const s = this._stats.get(event);
    if (s) s.emitted++;

    return super.emit(event, enriched);
  }

  getStats() {
    const result = {};
    for (const [event, s] of this._stats) {
      result[event] = { ...s };
    }
    return result;
  }

  clearStats() {
    this._stats.clear();
  }
}

// Singleton
const bus = new DomainEventBus();

// Built-in listener: log all events at debug level
bus.on('*', () => {}); // placeholder — real logging in subscribers

module.exports = bus;
module.exports.EVENTS = EVENTS;
