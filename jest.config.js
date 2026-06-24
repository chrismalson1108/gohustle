// Unit tests for pure logic modules (no native imports). Runs in a node env
// with babel-jest using babel.config.js (babel-preset-expo).
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/ios/', '/android/', '/web/'],
};
