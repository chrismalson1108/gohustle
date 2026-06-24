import { LEVELS } from './constants.js';

// Resolve the current/next level + progress fraction for a given XP total.
// Mirrors getLevelInfo in src/context/UserContext.js.
export function getLevelInfo(xp) {
  let current = LEVELS[0];
  let next = LEVELS[1];
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (xp >= LEVELS[i].minXP) {
      current = LEVELS[i];
      next = LEVELS[i + 1] || null;
      break;
    }
  }
  const progress = next
    ? (xp - current.minXP) / (next.minXP - current.minXP)
    : 1;
  return { current, next, progress };
}
