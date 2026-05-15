// ── WhatsappErdBot — Jest Configuration ────────────────────────

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.test.js', '**/*.spec.js'],
  collectCoverageFrom: [
    'src/services/**/*.js',
    'src/utils/**/*.js',
    '!src/**/*.test.js',
  ],
  coverageThreshold: {
    global: {
      statements: 0,
      branches: 0,
      functions: 0,
      lines: 0,
    },
  },
  // Mock modules that need DB or network
  moduleNameMapper: {
    '^../database/connection$': '<rootDir>/tests/__mocks__/db.js',
  },
  setupFilesAfterSetup: [],
};
