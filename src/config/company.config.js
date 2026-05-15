'use strict';

/**
 * ╔══════════════════════════════════════════════╗
 * ║  عدّل هذا الملف فقط لكل شركة                 ║
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

  // 📦 Orders
  orders: {
    orderPrefix: 'ORD',
    requireConfirmation: true,
    autoCancelHours: 24,
  },

  // 📋 Catalog
  catalog: {
    format: 'text',
    showOnlyAvailable: true,
    includePrices: true,
  },

  // 💬 Messages
  messages: {
    welcome: 'مرحباً بك في {companyName}! 👋\nكيف يمكنني مساعدتك اليوم؟',
    outOfScope: 'أنا متخصص فقط في {domain}. كيف يمكنني مساعدتك في هذا المجال؟',
  },
};
