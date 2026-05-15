'use strict';

const OpenAI = require('openai');
const logger = require('../utils/logger');
const db = require('../database/connection');
const settings = require('../utils/settings');
const config = require('../config/company.config');

/**
 * AI gateway. Uses OpenCode Go's OpenAI-compatible endpoint.
 *
 * Hardening relative to the original:
 *   - lazy client (no API key required to load the module)
 *   - retries with exponential backoff
 *   - per-request timeout
 *   - persisted conversation memory in `ai_memory` (survives restarts)
 *   - JSON helper accepts maxRetriesOverride to keep latency low
 *     for the structured-extraction path (intent classify / order extract)
 */
class AIService {
  constructor() {
    this._client = null;
    this.model = process.env.AI_MODEL || 'qwen3.5-plus';
    this.maxTokens = parseInt(process.env.AI_MAX_TOKENS, 10) || 800;
    this.temperature = parseFloat(process.env.AI_TEMPERATURE) || 0.7;
    this.maxRetries = parseInt(process.env.AI_MAX_RETRIES, 10) || 3;
    this.timeout = parseInt(process.env.AI_TIMEOUT, 10) || 15000;
    this.company = null;

    // Periodic cleanup of old conversation memory
    const HOUR = 60 * 60 * 1000;
    setInterval(() => this._pruneMemory(), 6 * HOUR).unref();
  }

  _pruneMemory() {
    try {
      const ttl = settings.getInt('ai_memory_ttl_hours', 72);
      const r = db.getMain().prepare(`
        DELETE FROM ai_memory WHERE created_at < datetime('now', '-' || ? || ' hours')
      `).run(ttl);
      if (r.changes > 0) logger.info(`AI memory pruned: ${r.changes} rows`);
    } catch (err) {
      logger.warn(`AI memory prune failed: ${err.message}`);
    }
  }

  get client() {
    if (!this._client) {
      if (!process.env.OPENCODE_GO_API_KEY) {
        throw new Error('OPENCODE_GO_API_KEY is not set');
      }
      this._client = new OpenAI({
        apiKey: process.env.OPENCODE_GO_API_KEY,
        baseURL: process.env.AI_BASE_URL || 'https://opencode.ai/zen/go/v1',
      });
    }
    return this._client;
  }

  setCompany(company) {
    this.company = company;
  }

  buildSystemPrompt() {
    const c = this.company;
    if (!c) return 'You are a helpful assistant for a business.';

    // Load products from catalog (cached 60s)
    let productContext = '';
    const now = Date.now();
    if (!this._catalogCache || (now - this._catalogCacheTime) > 60000) {
      try {
        this._catalogCache = db.getProducts().prepare(`
          SELECT p.name, COALESCE(p.name_ar, '') AS name_ar, COALESCE(p.discount_price, p.price) AS price,
                 p.stock_quantity, c2.name AS category
            FROM products p
            LEFT JOIN categories c2 ON p.category_id = c2.id
           WHERE p.is_available = 1
           ORDER BY p.total_sold DESC LIMIT 30
        `).all();
        this._catalogCacheTime = now;
      } catch (_) { this._catalogCache = []; }
    }
    const products = this._catalogCache || [];
    if (products.length) {
      const lines = products.map((p) =>
        `- ${p.name}${p.name_ar ? ' (' + p.name_ar + ')' : ''} — ${p.price} ${c.symbol || 'ر.س'} [${p.category || 'عام'}] — ${p.stock_quantity > 0 ? 'متوفر' : 'غير متوفر'}`
      );
      let text = lines.join('\n');
      if (text.length > 2500) text = text.substring(0, 2500) + '\n... والمزيد';
      productContext = '\nالمنتجات المتوفرة:\n' + text;
    }

    const cats = [];
    try {
      db.getProducts().prepare(
        'SELECT name FROM categories WHERE is_active = 1 AND id != 1 ORDER BY sort_order LIMIT 6'
      ).all().forEach((r) => cats.push(r.name));
    } catch (_) {}

    const supNames = (config.supervisors || []).map((s) => s.name).join('، ') || 'المشرف';
    const whStart = settings.get('working_hours_start') || '09:00';
    const whEnd = settings.get('working_hours_end') || '22:00';

    return `أنت موظف مبيعات محترف في متجر "${c.name}".
المجال: ${c.domain || 'عام'}
العملة: ${c.symbol || 'ر.س'}
المدينة: ${c.city || ''}
اللغة: العربية
مواعيد العمل: من ${whStart} إلى ${whEnd}

شخصيتك:
- ودود ومبادر — مثل أفضل مندوب مبيعات
- خبير بمنتجات المتجر وتساعد العميل في اختيار الأنسب
- تقترح منتجات بديلة إذا كان المنتج المطلوب غير متوفر
- إذا سأل العميل عن منتج غير موجود في القائمة، قل: "للأسف هذا المنتج غير متوفر حالياً. هل تفضل تجربة {اقترح بديل من نفس الفئة}؟"

${productContext || ''}

الفئات: ${cats.length ? cats.join(' | ') : 'عام'}

معلومات تشغيلية:
- للتواصل مع مشرف: "${supNames}"
- التوصيل متاح في ${c.city || 'جميع المدن'}. يرجى مشاركة موقعك لتحديد العنوان.
- أوقات الدوام: من ${whStart} إلى ${whEnd}

قواعد صارمة (ممنوع مخالفتها):
- لا تتحدث أبداً عن: السياسة، الدين، الرياضة، الطب، القانون، التقنية، البرمجة
- لا تخترع منتجات غير موجودة في القائمة أعلاه
- لا تخترع أسعاراً — استخدم الأسعار من القائمة فقط
- إذا سأل العميل عن شيء خارج نطاق ${c.domain || 'العطور'}، قل: "أنا متخصص فقط في ${c.domain || 'مجالنا'}. كيف أقدر أساعدك اليوم؟"
- ردودك مختصرة ومفيدة (4-5 أسطر)
- استخدم الإيموجي باعتدال 🌹✨
- اختتم كل رد بسؤال مفتوح يشجع العميل على الاستمرار`;
  }

  async chat(messages, options = {}) {
    let lastError;
    const attempts = options.maxRetriesOverride || this.maxRetries;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: options.model || this.model,
          temperature: options.temperature != null ? options.temperature : this.temperature,
          max_tokens: options.maxTokens || this.maxTokens,
          messages,
        }, { timeout: this.timeout });

        const content = response.choices?.[0]?.message?.content;
        if (!content) throw new Error('Empty AI response');

        return {
          text: content.trim(),
          tokens: response.usage?.total_tokens || 0,
        };
      } catch (err) {
        lastError = err;
        logger.warn(`AI attempt ${attempt}/${attempts} failed: ${err.message}`);
        if (attempt < attempts) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }
    throw lastError;
  }

  async askJSON(systemPrompt, userContent, options = {}) {
    const res = await this.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      { temperature: 0.1, ...options },
    );

    // Strip code fences and find the first JSON value.
    let clean = res.text.replace(/```(?:json)?\n?/g, '').trim();
    const firstBrace = clean.search(/[\[{]/);
    if (firstBrace > 0) clean = clean.slice(firstBrace);

    try {
      return JSON.parse(clean);
    } catch (err) {
      logger.warn('JSON parse failed, raw: ' + clean.substring(0, 120));
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Persisted conversation memory
  // ────────────────────────────────────────────────────────────────────

  _loadHistory(sessionId, max) {
    try {
      const rows = db.getMain().prepare(`
        SELECT role, content FROM ai_memory
         WHERE session_id = ?
         ORDER BY id DESC
         LIMIT ?
      `).all(sessionId, max);
      return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
    } catch (err) {
      logger.warn(`AI history load failed: ${err.message}`);
      return [];
    }
  }

  _saveTurn(sessionId, role, content) {
    try {
      db.getMain().prepare(`
        INSERT INTO ai_memory (session_id, role, content) VALUES (?, ?, ?)
      `).run(sessionId, role, content);
    } catch (err) {
      logger.warn(`AI history write failed: ${err.message}`);
    }
  }

  async generateReply(sessionId, userMessage) {
    const max = settings.getInt('ai_history_max_messages', 20);
    const history = this._loadHistory(sessionId, max);

    const messages = [
      { role: 'system', content: this.buildSystemPrompt() },
      ...history,
      { role: 'user', content: userMessage },
    ];

    const res = await this.chat(messages);
    const filtered = this._filterResponse(res.text);
    this._saveTurn(sessionId, 'user', userMessage);
    this._saveTurn(sessionId, 'assistant', filtered);
    return { ...res, text: filtered };
  }

  _filterResponse(text) {
    if (!text) return text;

    // Off-topic guardrail — check for forbidden topics
    const offTopicRE = /سياسة|دين|رياضه|رياضة|طب|قانون|حرب|انتخاب|برمجه|برمجة|تقنيه|تقنية|كمبيوتر|صحه|صحة|دواء|كوره|كرة|افلام|أفلام|موسيقى|سياره|سيارة/i;
    const matches = (text.match(offTopicRE) || []);
    if (matches.length >= 3) {
      const oos = (config.messages && config.messages.outOfScope)
        ? config.messages.outOfScope
            .replace('{companyName}', (this.company && this.company.name) || 'المتجر')
            .replace('{domain}', (this.company && this.company.domain) || 'مجالنا')
        : `أنا متخصص فقط في ${(this.company && this.company.domain) || 'مجالنا'}. كيف أقدر أساعدك اليوم؟ 🌹`;
      logger.info('AI guardrail: off-topic response filtered');
      return oos;
    }

    // Product name verification — strip invented products
    try {
      const known = new Set();
      db.getProducts().prepare('SELECT name, COALESCE(name_ar, \'\') AS name_ar FROM products').all()
        .forEach((p) => { known.add(p.name.toLowerCase()); if (p.name_ar) known.add(p.name_ar.toLowerCase()); });

      const lines = text.split('\n');
      const filtered = lines.map((line) => {
        // Check if any known product appears in this line — if yes, keep it
        for (const name of known) {
          if (name.length > 2 && line.toLowerCase().includes(name)) return line;
        }
        // If line has a price pattern (number + currency) but no known product, strip price
        if (/\d+\s*(ر\.س|SAR|ريال)/.test(line) && ![...known].some((n) => n.length > 2 && line.toLowerCase().includes(n))) {
          return line.replace(/\d+\s*(ر\.س|SAR|ريال)/g, '--- ر.س');
        }
        return line;
      });
      text = filtered.join('\n');
    } catch (_) { /* DB not ready, skip product verification */ }

    return text;
  }

  clearHistory(sessionId) {
    try {
      db.getMain().prepare(
        'DELETE FROM ai_memory WHERE session_id = ?'
      ).run(sessionId);
    } catch (err) {
      logger.warn(`AI history clear failed: ${err.message}`);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Structured tasks
  // ────────────────────────────────────────────────────────────────────

  async classifyIntent(text) {
    try {
      const result = await this.askJSON(
        `Classify this message. Reply with ONLY a JSON object, no explanation.
{
  "intent": "greeting|order|product_inquiry|price_inquiry|catalog_request|categories_request|complaint|supervisor_request|other",
  "confidence": 0.0
}`,
        text,
        { maxTokens: 800, temperature: 0.1, maxRetriesOverride: 1 },
      );
      return result?.intent || 'other';
    } catch (_) {
      return 'other';
    }
  }

  async extractOrder(text) {
    try {
      return await this.askJSON(
        `Extract order details. Reply with ONLY a JSON object, no explanation.
{
  "hasOrder": true,
  "items": [
    { "productName": "string", "quantity": 1, "confidence": 0.9 }
  ],
  "needsConfirmation": true
}
If no clear order is present, set hasOrder to false and items to [].`,
        text,
        { maxTokens: 1200, temperature: 0.1, maxRetriesOverride: 1 },
      );
    } catch (_) {
      return { hasOrder: false, items: [] };
    }
  }
}

module.exports = new AIService();
