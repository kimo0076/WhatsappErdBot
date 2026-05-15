'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Structured configuration builder.
 *
 * Loads .env, validates required keys, provides typed accessors,
 * and resolves file paths relative to the project root.
 */

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function loadEnv() {
  try {
    require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') });
  } catch (err) {
    console.warn('dotenv not available, using process.env');
  }
}

const REQUIRED_KEYS = ['OPENCODE_GO_API_KEY'];

function validate() {
  const missing = REQUIRED_KEYS.filter((k) => !process.env[k]);
  if (missing.length) {
    console.warn(`Missing recommended env vars: ${missing.join(', ')}`);
  }
}

function build() {
  loadEnv();
  validate();

  return Object.freeze({
    // Project
    root: PROJECT_ROOT,
    env: process.env.NODE_ENV || 'production',
    logLevel: process.env.LOG_LEVEL || 'info',

    // Database
    mainDbPath: process.env.MAIN_DB_PATH || path.join(PROJECT_ROOT, 'data', 'database', 'main.db'),
    productsDbPath: process.env.PRODUCTS_DB_PATH || path.join(PROJECT_ROOT, 'data', 'database', 'products.db'),
    waSessionPath: process.env.WA_SESSION_PATH || path.join(PROJECT_ROOT, 'data', 'auth_info'),

    // AI
    aiProvider: process.env.AI_PROVIDER || 'opencode-go',
    aiApiKey: process.env.OPENCODE_GO_API_KEY || '',
    aiModel: process.env.AI_MODEL || 'deepseek-v4-flash',
    aiMaxTokens: parseInt(process.env.AI_MAX_TOKENS, 10) || 2500,
    aiTemperature: parseFloat(process.env.AI_TEMPERATURE) || 0.7,
    aiTimeout: parseInt(process.env.AI_TIMEOUT, 10) || 15000,
    aiMaxRetries: parseInt(process.env.AI_MAX_RETRIES, 10) || 3,
    aiBaseUrl: process.env.AI_BASE_URL || 'https://opencode.ai/zen/go/v1',

    // Health
    healthPort: parseInt(process.env.HEALTH_PORT, 10) || 3099,

    // Backup
    backupEnabled: process.env.BACKUP_ENABLED !== 'false',
    backupKeepDays: parseInt(process.env.BACKUP_KEEP_DAYS, 10) || 30,
  });
}

module.exports = { build, validate, PROJECT_ROOT };
