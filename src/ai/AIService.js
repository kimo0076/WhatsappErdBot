'use strict';

const OpenAI = require('openai');
const logger = require('../utils/logger');

class AIService {
  constructor() {
    this._client = null;
    this.model = process.env.AI_MODEL || 'qwen3.5-plus';
    this.maxTokens = parseInt(process.env.AI_MAX_TOKENS) || 800;
    this.temperature = parseFloat(process.env.AI_TEMPERATURE) || 0.7;
    this.maxRetries = parseInt(process.env.AI_MAX_RETRIES) || 3;
    this.timeout = parseInt(process.env.AI_TIMEOUT) || 30000;

    this.history = new Map();
    this.company = null;

    const HOUR = 60 * 60 * 1000;
    setInterval(() => {
      const cutoff = Date.now() - 4 * HOUR;
      let cleaned = 0;
      for (const [key, entry] of this.history) {
        if (entry._ts && entry._ts < cutoff) {
          this.history.delete(key);
          cleaned++;
        }
      }
      if (cleaned > 0) logger.info(`AI history cleanup: removed ${cleaned} sessions`);
    }, 30 * 60 * 1000).unref();
  }

  get client() {
    if (!this._client) {
      if (!process.env.OPENCODE_GO_API_KEY) {
        throw new Error('OPENCODE_GO_API_KEY is not set');
      }
      this._client = new OpenAI({
        apiKey: process.env.OPENCODE_GO_API_KEY,
        baseURL: 'https://opencode.ai/zen/go/v1',
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

    return `أنت مساعد ذكي ومحترف لمتجر "${c.name}".
المجال: ${c.domain || 'عام'}
العملة: ${c.symbol || 'ر.س'}
المدينة: ${c.city || ''}
اللغة: العربية

مهامك:
- الرد على العملاء بأسلوب ودّي ومهني باللغة العربية
- مساعدة العملاء في اختيار المنتجات المناسبة
- الإجابة على أسئلة عن المنتجات والأسعار
- استقبال الطلبات وتأكيدها للعميل
- إذا سأل العميل عن موضوع خارج ${c.domain || 'مجالنا'}، اشرح له بلطف تخصصك وادعه للاستفسار عن منتجاتنا

قواعد:
- ردودك قصيرة وواضحة (3-5 أسطر كحد أقصى)
- استخدم الإيموجي باعتدال 🌹✨
- لا تخترع أسعاراً دقيقة، قل: "سأتحقق لك من السعر"
- كن دقيقاً ومفيداً
- إذا طلب العميل التحدث مع مشرف: "سيتواصل معك أحد مندوبينا قريباً ⏰"`;
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
        }, {
          timeout: this.timeout,
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
          logger.warn('AI returned empty response: ' + JSON.stringify(response.choices[0]));
          throw new Error('Empty AI response');
        }

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

    const clean = res.text.replace(/```(?:json)?\n?/g, '').trim();
    try {
      return JSON.parse(clean);
    } catch {
      logger.warn('JSON parse failed, raw: ' + clean.substring(0, 100));
      return null;
    }
  }

  async generateReply(sessionId, userMessage) {
    if (!this.history.has(sessionId)) {
      this.history.set(sessionId, []);
    }

    const history = this.history.get(sessionId);
    history._ts = Date.now();
    const messages = [
      { role: 'system', content: this.buildSystemPrompt() },
      ...history.slice(-10),
      { role: 'user', content: userMessage },
    ];

    const res = await this.chat(messages);

    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'assistant', content: res.text });

    if (history.length > 20) {
      history.splice(0, 2);
    }

    return res;
  }

  clearHistory(sessionId) {
    this.history.delete(sessionId);
  }

  async classifyIntent(text) {
    try {
      const result = await this.askJSON(
        `Classify this message. Reply with ONLY the JSON object, no explanation.
{
  "intent": "greeting|order|product_inquiry|price_inquiry|catalog_request|categories_request|complaint|supervisor_request|other",
  "confidence": 0.0
}`,
        text,
        { maxTokens: 1500, temperature: 0.1, maxRetriesOverride: 1 },
      );
      return result?.intent || 'other';
    } catch {
      return 'other';
    }
  }

  async extractOrder(text) {
    try {
      return await this.askJSON(
        `Extract order details. Reply with ONLY the JSON object, no explanation.
{
  "hasOrder": true,
  "items": [
    { "productName": "string", "quantity": 1, "confidence": 0.9 }
  ],
  "needsConfirmation": true
}
If no clear order, set hasOrder to false and items to [].`,
        text,
        { maxTokens: 2000, temperature: 0.1, maxRetriesOverride: 1 },
      );
    } catch {
      return { hasOrder: false, items: [] };
    }
  }
}

module.exports = new AIService();
