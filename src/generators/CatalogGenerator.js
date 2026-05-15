'use strict';

const ProductService = require('../services/ProductService');
const config = require('../config/company.config');

class CatalogGenerator {
  async generateText() {
    const products = ProductService.getAllAvailable();
    const company = config.company;

    if (!products.length) {
      return `🏪 *${company.name}*\n\nلا توجد منتجات متاحة حالياً.`;
    }

    const grouped = {};
    for (const p of products) {
      const cat = p.category_name || 'عام';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(p);
    }

    const lines = [];
    lines.push(`🏪 *${company.name}*`);
    lines.push(`📞 ${company.phone}`);
    lines.push('━━━━━━━━━━━━━━━━━━');
    lines.push('');

    let n = 1;
    for (const [cat, items] of Object.entries(grouped)) {
      lines.push(`📂 *${cat}*`);
      lines.push('');

      for (const p of items) {
        const price = p.discount_price
          ? `~~${p.price}~~ *${p.discount_price}* ${company.symbol}`
          : `*${p.price}* ${company.symbol}`;

        lines.push(`${n}. *${p.name}*`);
        lines.push(`   💰 ${price}  |  📦 ${p.stock_quantity} ${p.unit || 'قطعة'}`);
        if (p.description) {
          lines.push(`   ${p.description.substring(0, 80)}`);
        }
        lines.push('');
        n++;
      }
    }

    lines.push('━━━━━━━━━━━━━━━━━━');
    lines.push('📝 للطلب: اكتب *رقم المنتج* أو *اسمه* مع الكمية');
    lines.push(`مثال: أريد 2 من ${products[0]?.name || 'المنتج رقم 1'}`);

    return lines.join('\n');
  }

  async generateCompact() {
    const products = ProductService.getAllAvailable();
    const company = config.company;

    if (!products.length) {
      return 'لا توجد منتجات.';
    }

    const lines = [];
    lines.push(`📋 *منتجات ${company.name}:*`);

    let n = 1;
    for (const p of products) {
      const price = p.discount_price || p.price;
      lines.push(`${n}. ${p.name} — ${price} ${company.symbol}`);
      n++;
      if (n > 20) {
        lines.push(`... والمزيد. اكتب *بحث <اسم>* للبحث.`);
        break;
      }
    }

    return lines.join('\n');
  }

  async generateByCategory(categoryName) {
    const products = ProductService.getByCategory(categoryName);
    const company = config.company;

    if (!products.length) {
      return `لم أجد منتجات في فئة "${categoryName}".\nاكتب *منتجات* لعرض كل الفئات.`;
    }

    const lines = [];
    lines.push(`📂 *${categoryName}*`);
    lines.push('');

    for (const p of products) {
      const price = p.discount_price || p.price;
      lines.push(`• *${p.name}* — ${price} ${company.symbol}`);
      if (p.description) {
        lines.push(`  ${p.description.substring(0, 60)}`);
      }
      lines.push(`  📦 ${p.stock_quantity > 0 ? 'متوفر ✅' : 'غير متوفر ❌'}`);
      lines.push('');
    }

    return lines.join('\n');
  }
}

module.exports = new CatalogGenerator();
