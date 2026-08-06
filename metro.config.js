// Metro config for the GoHustlr mobile app.
// TWO sibling Next.js projects live beside the app — web/ (the website) and admin/
// (the console) — each with its own node_modules and .next build output. Exclude
// both so their dependencies are never crawled or collided with the app's modules.
// The mobile app imports from neither; it only shares the sibling shared/ folder,
// which stays watched.
//
// This matters concretely: admin/ pins react/react-dom 19.2.4 while the app is on
// 19.1.0, so a stray resolution into admin/node_modules yields two Reacts and the
// invalid-hook-call crash that is notoriously hard to trace back to here. admin/
// was missing from this list until 2026-08-06.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const siblingProjectExclusions = [
  /[\\/]web[\\/]node_modules[\\/].*/,
  /[\\/]web[\\/]\.next[\\/].*/,
  /[\\/]admin[\\/]node_modules[\\/].*/,
  /[\\/]admin[\\/]\.next[\\/].*/,
];

const prev = config.resolver.blockList;
config.resolver.blockList = []
  .concat(prev == null ? [] : Array.isArray(prev) ? prev : [prev])
  .concat(siblingProjectExclusions);

module.exports = config;
