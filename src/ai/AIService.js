'use strict';

const OpenAI = require('openai');
const logger = require('../utils/logger');
const db = require('../database/connection');
const settings = require('../utils/settings');

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
    this.timeout = parseInt(process.env.AI_TIMEOUT, 10) || 30000;
    this.company = null;
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
- استخدم الإيموجي باعتدال
- لا تخترع أسعاراً دقيقة، قل: "سأتحقق لك من السعر"
- كن دقيقاً ومفيداً
- إذا طلب العميل التحدث مع مشرف: "سيتواصل معك أحد مندوبينا قريباً"`;
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
    this._saveTurn(sessionId, 'user', userMessage);
    this._saveTurn(sessionId, 'assistant', res.text);
    return res;
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
