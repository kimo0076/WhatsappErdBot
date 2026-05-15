'use strict';

/**
 * Centralized enums and shared constants. Keeping these in one file makes
 * it impossible for the schema, services, and handlers to drift apart on
 * status strings (which was happening before).
 */

const ORDER_STATUS = Object.freeze({
  PENDING: 'pending',
  PENDING_APPROVAL: 'pending_supervisor_approval',
  CONFIRMED: 'confirmed',
  LOCATION_COLLECTED: 'location_collected',
  IN_TRANSIT: 'in_transit',
  DELIVERED: 'delivered',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

const ORDER_ITEM_STATUS = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  BACKORDER: 'backorder',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
});

const CONVERSATION_STATE = Object.freeze({
  IDLE: 'idle',
  AWAITING_CONFIRMATION: 'awaiting_confirmation',
  AWAITING_LOCATION: 'awaiting_location',
});

const SENDER_TYPE = Object.freeze({
  CUSTOMER: 'customer',
  BOT: 'bot',
  SUPERVISOR: 'supervisor',
});

const INVENTORY_REASON = Object.freeze({
  PURCHASE: 'purchase',
  SALE: 'sale',
  RETURN: 'return',
  DAMAGED: 'damaged',
  ADJUSTMENT: 'adjustment',
  INITIAL: 'initial',
  CANCEL_ORDER: 'cancel_order',
});

const STATUS_LABELS_AR = Object.freeze({
  [ORDER_STATUS.PENDING]: 'معلق',
  [ORDER_STATUS.PENDING_APPROVAL]: 'بانتظار موافقة المشرف',
  [ORDER_STATUS.CONFIRMED]: 'مؤكد',
  [ORDER_STATUS.LOCATION_COLLECTED]: 'تم استلام الموقع',
  [ORDER_STATUS.IN_TRANSIT]: 'قيد التوصيل',
  [ORDER_STATUS.DELIVERED]: 'تم التوصيل',
  [ORDER_STATUS.COMPLETED]: 'مكتمل',
  [ORDER_STATUS.CANCELLED]: 'ملغي',
});

// Statuses that count as "still active" for inventory reservation purposes.
const ACTIVE_ORDER_STATUSES = Object.freeze([
  ORDER_STATUS.PENDING,
  ORDER_STATUS.PENDING_APPROVAL,
  ORDER_STATUS.CONFIRMED,
  ORDER_STATUS.LOCATION_COLLECTED,
  ORDER_STATUS.IN_TRANSIT,
  ORDER_STATUS.DELIVERED,
]);

module.exports = {
  ORDER_STATUS,
  ORDER_ITEM_STATUS,
  CONVERSATION_STATE,
  SENDER_TYPE,
  INVENTORY_REASON,
  STATUS_LABELS_AR,
  ACTIVE_ORDER_STATUSES,
};
