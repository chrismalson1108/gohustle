import fs from 'node:fs';
import path from 'node:path';
import { CACHE, ensureFonts } from './bootstrap.mjs';

ensureFonts();
const A = CACHE;

// ── Fonts, embedded so the render never depends on the network ──────────────
const b64 = (p) => fs.readFileSync(p).toString('base64');
const interFace = (w) => `@font-face{font-family:Inter;font-style:normal;font-weight:${w};font-display:block;
  src:url(data:font/woff2;base64,${b64(path.join(A, 'package/files', `inter-latin-${w}-normal.woff2`))}) format('woff2');}`;
export const FONT_CSS = [400, 500, 600, 700, 800].map(interFace).join('\n') + `
@font-face{font-family:Ionicons;font-style:normal;font-weight:400;font-display:block;
  src:url(data:font/ttf;base64,${b64(path.join(A, 'package/Fonts/Ionicons.ttf'))}) format('truetype');}`;

const GLYPHS = JSON.parse(fs.readFileSync(path.join(A, 'package/glyphmaps/Ionicons.json'), 'utf8'));

/** Ionicons glyph, sized and coloured exactly as the RN <Ionicons> call would be. */
export function I(name, size, color, extra = '') {
  const cp = GLYPHS[name];
  if (cp == null) throw new Error(`Unknown Ionicon: ${name}`);
  return `<span class="ion" style="font-size:${size}px;color:${color};${extra}">&#${cp};</span>`;
}

// ── Design tokens — mirrored from shared/theme.js ────────────────────────────
export const c = {
  primary: '#5038FF', primaryDark: '#2E1BC7', primaryLight: '#EAE6FF', secondary: '#6B54FF',
  warning: '#E0A44A', warningLight: '#FDF0DA', warningDeep: '#8A5A12',
  wash: '#EAE6FF', washDeep: '#5038FF', rating: '#E0A44A',
  urgent: '#EA4637', urgentLight: '#FFE7E3',
  background: '#F7F4EC', surface: '#FFFFFF',
  textPrimary: '#363636', textSecondary: '#6B6482', textMuted: '#9A93AD',
  border: '#E4DFD3', divider: '#EFEBE1',
  success: '#15803D', successLight: '#E7F8EE',
};
export const shadowCard = '0 2px 10px rgba(0,0,0,0.05)';
export const shadowSm = '0 1px 4px rgba(0,0,0,0.04)';
export const shadowMd = '0 4px 12px rgba(0,0,0,0.08)';

// Device: iPhone 6.5" logical points. Rendered at 3x for 1284 x 2778.
export const W = 428, H = 926, TOP_INSET = 44, BOTTOM_INSET = 34;

/** Initial-letter avatar, the Avatar.js fallback. */
export const avatar = (initial, size, fontSize, bg = c.primary, extra = '') =>
  `<div style="width:${size}px;height:${size}px;border-radius:999px;background:${bg};color:#fff;
    display:flex;align-items:center;justify-content:center;font-size:${fontSize}px;font-weight:600;
    flex-shrink:0;${extra}">${initial}</div>`;

/** RatingStars — amber glyph + ink value. */
export const stars = (rating, size = 13) =>
  `<span style="display:inline-flex;align-items:center;flex-shrink:0">
     <span style="color:${c.rating};font-size:${size}px;margin-right:4px;line-height:1">&#9733;</span>
     <span style="font-size:${size}px;font-weight:600;color:${c.textPrimary};line-height:1">${rating.toFixed(1)}</span>
   </span>`;

/** iOS status bar. */
export const statusBar = (tint = c.textPrimary) => `
<div class="statusbar" style="color:${tint}">
  <div class="sb-time">9:41</div>
  <div class="sb-right">
    <svg width="18" height="12" viewBox="0 0 18 12" fill="${tint}"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
    <svg width="17" height="12" viewBox="0 0 17 12" fill="${tint}"><path d="M8.5 11.4 6.2 8.9a3.4 3.4 0 0 1 4.6 0zM3.6 6.2 2 4.5a9.6 9.6 0 0 1 13 0l-1.6 1.7a7.3 7.3 0 0 0-9.8 0zM5.3 8l-1.6-1.7a7 7 0 0 1 9.6 0L11.7 8a4.7 4.7 0 0 0-6.4 0z"/></svg>
    <svg width="26" height="12" viewBox="0 0 26 12"><rect x="0.5" y="0.5" width="21" height="11" rx="3" fill="none" stroke="${tint}" stroke-opacity="0.4"/><rect x="2" y="2" width="16" height="8" rx="1.6" fill="${tint}"/><path d="M23 4v4a2.2 2.2 0 0 0 0-4z" fill="${tint}" fill-opacity="0.5"/></svg>
  </div>
</div>`;

/** Floating pill tab bar, expanded state (FloatingTabBar at progress = 1). */
export function tabBar(active) {
  const tabs = [
    { key: 'HomeTab', title: 'Browse', on: 'search', off: 'search-outline' },
    { key: 'EarnTab', title: 'My Jobs', on: 'briefcase', off: 'briefcase-outline', badge: 1 },
    { key: 'GigsTab', title: 'Hire', on: 'megaphone', off: 'megaphone-outline' },
    { key: 'MessagesTab', title: 'Messages', on: 'chatbubble', off: 'chatbubble-outline', badge: 2 },
    { key: 'ProfileTab', title: 'You', on: 'person-circle', off: 'person-circle-outline' },
  ];
  return `<div class="tabbar">${tabs.map(t => {
    const focused = t.key === active;
    const col = focused ? c.primary : c.textMuted;
    return `<div class="tabitem">
      <div style="position:relative">${I(focused ? t.on : t.off, 23, col)}
        ${t.badge ? `<div class="tabbadge">${t.badge}</div>` : ''}
      </div>
      <div class="tablabel" style="color:${col}">${t.title}</div>
    </div>`;
  }).join('')}</div>`;
}

/** iOS native navigation bar (pushed screens). */
export const navBar = (title = '', right = '') => `
<div class="navbar">
  <div class="nav-back">${I('chevron-back', 26, c.textPrimary)}</div>
  <div class="nav-title">${title}</div>
  <div class="nav-right">${right}</div>
</div>`;

export const SHELL_CSS = `
${FONT_CSS}
*{box-sizing:border-box;margin:0;padding:0;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
html,body{margin:0;padding:0;background:#fff}
body{font-family:Inter,sans-serif;color:${c.textPrimary};font-feature-settings:"cv05" 1,"ss03" 1}
.ion{font-family:Ionicons;font-weight:400;line-height:1;display:inline-block;font-style:normal}
.device{width:${W}px;height:${H}px;overflow:hidden;position:relative;background:${c.background};display:flex;flex-direction:column}
.statusbar{height:${TOP_INSET}px;flex:0 0 ${TOP_INSET}px;display:flex;align-items:flex-end;justify-content:space-between;
  padding:0 26px 8px;font-size:16px;font-weight:600;letter-spacing:-0.2px}
.sb-right{display:flex;align-items:center;gap:6px}
.body{flex:1;min-height:0;position:relative;overflow:hidden;display:flex;flex-direction:column}
.scroll{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column}
/* A scroll view clips at its bottom edge; it never squashes its rows. */
.scroll>*{flex-shrink:0}
.tabbar{position:absolute;left:20px;right:20px;bottom:${BOTTOM_INSET}px;background:${c.surface};border-radius:999px;
  padding:11px 8px;display:flex;align-items:center;box-shadow:${shadowMd}}
.tabitem{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2px 0}
.tablabel{font-size:10.5px;font-weight:600;margin-top:2px;line-height:15px}
.tabbadge{position:absolute;top:-4px;right:-8px;background:${c.urgent};border-radius:8px;min-width:15px;height:15px;
  display:flex;align-items:center;justify-content:center;padding:1px 3px;color:#fff;font-size:9px;font-weight:700}
.navbar{height:44px;flex:0 0 44px;background:${c.background};
  display:flex;align-items:center;padding:0 8px;position:relative}
.nav-back{width:44px;display:flex;align-items:center;justify-content:flex-start;padding-left:2px}
.nav-title{position:absolute;left:0;right:0;text-align:center;font-size:17px;font-weight:700;letter-spacing:-0.3px;pointer-events:none}
.nav-right{margin-left:auto;display:flex;align-items:center;gap:12px;padding-right:8px;z-index:1}
.row{display:flex;align-items:center}
.card{background:${c.surface};border-radius:20px;box-shadow:${shadowCard}}
`;

/** Wrap one screen's markup in a full HTML document. */
export function doc(inner, extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${SHELL_CSS}${extraCss}</style></head>
<body><div class="device">${inner}</div></body></html>`;
}
