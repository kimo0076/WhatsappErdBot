'use strict';

/**
 * ╔══════════════════════════════════════════════╗
 * ║  Company Configuration — Single Source of Truth ║
 * ║  Designed by Mohammed Hashem Almashehary     ║
 * ╚══════════════════════════════════════════════╝
 */

module.exports = {

  // 🏪 Company Info
  company: {
    name: 'متجر عطورك الفاخرة',
    nameEn: 'Your Luxury Perfumes',
    phone: '966501234567',
    email: 'info@perfumes.com',
    address: 'الرياض، السعودية',
    city: 'الرياض',
    country: 'SA',
    currency: 'SAR',
    symbol: 'ر.س',
    language: 'ar',
    timezone: 'Asia/Riyadh',
    domain: 'عطور وبخور فاخرة',
    website: '',
  },

  // 👥 Supervisors (who receives order notifications)
  supervisors: [
    { phone: '966573881894', name: 'المشرف العام', role: 'owner' },
  ],

  // 🕐 Working Hours
  workingHours: {
    start: '09:00',
    end: '22:00',
  },

  // 📦 Orders
  orders: {
    orderPrefix: 'ORD',
    requireConfirmation: true,
    autoApprove: false,
    autoCancelHours: 24,
    maxOrderQty: 100,
  },

  // 🚚 Delivery
  delivery: {
    defaultPhone: null,
    policy: 'التوصيل متاح في جميع أنحاء المدينة. يرجى مشاركة موقعك لتحديد العنوان.',
    agents: [
      // { phone: '9665xxxxxxxx', name: 'مندوب التوصيل', vehicle: 'سيارة' },
    ],
  },

  // 📋 Catalog
  catalog: {
    format: 'text',
    showOnlyAvailable: true,
    includePrices: true,
  },

  // 💬 Messages (use {companyName} and {domain} placeholders)
  messages: {
    welcome: 'مرحباً بك في {companyName}! 👋\nكيف يمكنني مساعدتك اليوم؟',
    outOfScope: 'أنا متخصص فقط في {domain}. كيف يمكنني مساعدتك في هذا المجال؟',
    orderConfirmed: '✅ *تم تأكيد طلبك!*\n🆔 رقم الطلب: *{orderNumber}*\n💰 الإجمالي: {total} {symbol}\n\n📍 الرجاء مشاركة موقعك لتحديد عنوان التوصيل.',
    orderCancelled: '❌ تم إلغاء طلبك {orderNumber}.\n📝 السبب: {reason}',
    backorderNotice: '⚠️ بعض المنتجات غير متوفرة. سيتم مراجعة طلبك من المشرف.',
    locationRequest: '📍 *الرجاء مشاركة موقعك* لتحديد عنوان التوصيل.\nيمكنك إرسال موقعك عبر واتساب أو كتابة العنوان يدوياً.',
  },
};
