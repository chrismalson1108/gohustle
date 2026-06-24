// Metro config for the GoHustlr mobile app.
// The website lives in web/ (its own Next.js project with its own node_modules).
// Exclude it from Metro so its dependencies (react, react-dom, next, .next build
// output) are never crawled or collided with the app's modules. The mobile app
// never imports from web/ — only from the sibling shared/ folder, which stays
// watched.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const webExclusions = [
  /[\\/]web[\\/]node_modules[\\/].*/,
  /[\\/]web[\\/]\.next[\\/].*/,
];

const prev = config.resolver.blockList;
config.resolver.blockList = []
  .concat(prev == null ? [] : Array.isArray(prev) ? prev : [prev])
  .concat(webExclusions);

module.exports = config;
