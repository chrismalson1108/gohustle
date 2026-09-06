// Unit tests for pure logic modules (no native imports). Runs in a node env
// with babel-jest using babel.config.js (babel-preset-expo).
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  // '/.claude/' is load-bearing: agent worktrees live at .claude/worktrees/<name>,
  // INSIDE the repo. Without it a worktree's copy of __tests__ is collected too, and
  // `npm test` reports 1236 suites / 22678 tests — a green number that is mostly other
  // branches' tests, run against this branch's source. Observed 2026-09-05.
  testPathIgnorePatterns: ['/node_modules/', '/ios/', '/android/', '/web/', '/.claude/'],
};
