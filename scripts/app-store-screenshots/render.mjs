import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { SCREENS } from './screens.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const HTML_DIR = path.join(HERE, '.cache', 'html');
const OUT = path.join(ROOT, 'docs', 'app-store', 'screenshots');

// Any Chromium will do — this renders static local HTML. Prefer an explicit
// CHROME_PATH, then Playwright's bundled headless shell, then the usual system
// installs.
function findChrome() {
  const pw = fs.existsSync('/opt/pw-browsers')
    ? fs.readdirSync('/opt/pw-browsers').filter((d) => d.startsWith('chromium'))
    : [];
  const candidates = [
    process.env.CHROME_PATH,
    // headless_shell first: it has no window chrome to subtract (see below).
    ...pw.map((d) => path.join('/opt/pw-browsers', d, 'chrome-linux', 'headless_shell')),
    ...pw.map((d) => path.join('/opt/pw-browsers', d, 'chrome-linux', 'chrome')),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ].filter(Boolean);
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) {
    throw new Error(
      'No Chromium found. Install Chrome, or set CHROME_PATH to a Chromium binary.',
    );
  }
  return hit;
}
const CHROME = findChrome();
const HEADLESS = /headless_shell$/.test(CHROME) ? [] : ['--headless=new'];

// `--window-size` is the WINDOW, and `--headless=new` reserves browser chrome
// inside it — on this Chromium ~97px of height. The viewport therefore comes out
// shorter than asked for and the bottom of every screen is silently cropped,
// which is not something a rendered PNG makes obvious. So measure the difference
// once and add it back, rather than hardcoding an offset that is only right for
// one Chrome build. headless_shell has no chrome and measures 0.
function chromeInset(w, h) {
  fs.mkdirSync(HTML_DIR, { recursive: true });
  const probe = path.join(HTML_DIR, '_probe.html');
  fs.writeFileSync(probe, '<html><body><i id=o></i><script>'
    + "document.getElementById('o').textContent=innerWidth+','+innerHeight"
    + '</script></body></html>');
  const dom = execFileSync(CHROME, [
    ...HEADLESS, '--disable-gpu', '--no-sandbox',
    `--window-size=${w},${h}`, '--virtual-time-budget=500', '--dump-dom',
    `file://${probe}`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const m = dom.match(/id="o">(\d+),(\d+)</);
  if (!m) throw new Error('could not measure the browser viewport');
  return { dw: w - Number(m[1]), dh: h - Number(m[2]) };
}
const INSET = chromeInset(400, 800);

// App Store display classes. `scale` turns logical points into the required pixels.
const SIZES = {
  'iphone-6.9': { w: 440, h: 956, px: '1320x2868', scale: 3 },
  'iphone-6.5': { w: 428, h: 926, px: '1284x2778', scale: 3 },
};

fs.mkdirSync(HTML_DIR, { recursive: true });

function shoot(htmlPath, outPath, w, h, scale) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execFileSync(CHROME, [
    ...HEADLESS, '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-lcd-text', '--font-render-hinting=none', '--force-color-profile=srgb',
    `--force-device-scale-factor=${scale}`,
    `--window-size=${w + INSET.dw},${h + INSET.dh}`,
    `--screenshot=${outPath}`,
    `--virtual-time-budget=2000`,
    `file://${htmlPath}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

/** Marketing frame: brand band + caption above the device screen. */
function marketing(screenHtml, caption, deviceW, deviceH) {
  const body = screenHtml
    .replace(/^[\s\S]*?<body>/, '')
    .replace(/<\/body>[\s\S]*$/, '');
  const css = screenHtml.match(/<style>([\s\S]*?)<\/style>/)[1];
  // The phone is inset so the caption has room; the screen itself is untouched.
  const inset = 0.80;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}
html,body{background:#F7F4EC}
.mk{width:${deviceW}px;height:${deviceH}px;overflow:hidden;position:relative;
  background:linear-gradient(168deg,#F7F4EC 0%,#EFEAFE 58%,#E4DDFF 100%);
  display:flex;flex-direction:column;align-items:center}
.mk-cap{padding:${Math.round(deviceH * 0.062)}px 34px 0;text-align:center;font-size:${Math.round(deviceW * 0.072)}px;
  font-weight:800;letter-spacing:-0.9px;line-height:1.16;color:#2E1BC7;max-width:${Math.round(deviceW * 0.9)}px}
.mk-rule{width:46px;height:4px;border-radius:999px;background:#5038FF;opacity:0.35;margin-top:18px}
.mk-stage{position:absolute;left:50%;bottom:0;transform:translateX(-50%);
  width:${deviceW}px;height:${deviceH}px;pointer-events:none}
.mk-phone{position:absolute;left:50%;top:${Math.round(deviceH * 0.238)}px;transform:translateX(-50%) scale(${inset});
  transform-origin:top center;border-radius:${Math.round(54 / inset)}px;overflow:hidden;
  box-shadow:0 30px 70px rgba(46,27,199,0.22), 0 6px 18px rgba(0,0,0,0.10);
  border:3px solid rgba(255,255,255,0.9)}
.device{border-radius:${Math.round(54 / inset)}px}
</style></head><body>
<div class="mk">
  <div class="mk-cap">${caption}</div>
  <div class="mk-rule"></div>
  <div class="mk-phone">${body.replace(/<div class="device">/, '<div class="device">')}</div>
</div></body></html>`;
}

const only = process.argv[2];
for (const [name, spec] of Object.entries(SCREENS)) {
  if (only && !name.includes(only)) continue;
  for (const [sizeName, s] of Object.entries(SIZES)) {
    const html = spec.fn();
    // The device box tracks the display class so nothing is cropped on the taller 6.9".
    const sized = html
      .replace(/\.device\{width:428px;height:926px/, `.device{width:${s.w}px;height:${s.h}px`);

    const rawHtml = path.join(HTML_DIR, `${name}.${sizeName}.raw.html`);
    fs.writeFileSync(rawHtml, sized);
    shoot(rawHtml, path.join(OUT, sizeName, 'app-screens', `${name}.png`), s.w, s.h, s.scale);

    const mkHtml = path.join(HTML_DIR, `${name}.${sizeName}.mk.html`);
    fs.writeFileSync(mkHtml, marketing(sized, spec.caption, s.w, s.h));
    shoot(mkHtml, path.join(OUT, sizeName, 'with-captions', `${name}.png`), s.w, s.h, s.scale);

    process.stdout.write(`  ${sizeName}/${name} (${s.px})\n`);
  }
}
console.log('done');
