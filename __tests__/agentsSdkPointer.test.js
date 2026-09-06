// ─────────────────────────────────────────────────────────────────────────────
// AGENTS.md exists for exactly one reason: to name the SDK version whose docs a
// session must read. It is three lines long and the third is a URL. So the one
// thing it can get wrong is the number in that URL — and it did.
//
// The app moved Expo 54 → 55 (RN 0.81.5 → 0.83.10, React 19.1.0 → 19.2.0;
// TESTFLIGHT.md records the runtimeVersion fingerprint change). AGENTS.md kept
// pointing at https://docs.expo.dev/versions/v54.0.0/ and CLAUDE.md kept
// asserting "Expo SDK 54, React Native 0.81.5, React 19.1.0" — so every session
// that obeyed the instruction read the wrong reference for the runtime it was
// writing against. That is not hypothetical drift: 54 → 55 already flipped a
// default under this app (react-native-screens' full-screen back gesture, see
// the comment above DETAIL_OPTS in App.js), which is precisely the class of
// change a versioned doc pointer exists to surface.
//
// A prose pointer cannot be trusted to stay true, so it is derived here instead.
// package.json is the only place the SDK version actually lives; every human-read
// copy of it is checked against that. When the SDK majors move, this fails and
// names the file to edit.
//
// metro.config.js is in the same family: its comment justifies the admin/
// blockList by naming the two React versions that would collide. The numbers are
// the whole argument, and its app-side one had gone stale to 19.1.0.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const pkg = JSON.parse(read('package.json'));
const appReact = pkg.dependencies.react;
const appRn = pkg.dependencies['react-native'];
const adminReact = JSON.parse(read('admin/package.json')).dependencies.react;

// "~55.0.29" → "55". The range prefix is Expo's own convention for the SDK line;
// the major IS the SDK version.
const sdkMajor = pkg.dependencies.expo.replace(/^[^\d]*/, '').split('.')[0];

describe('AGENTS.md points at the SDK the app is actually on', () => {
  const agents = read('AGENTS.md');

  it('derives a plausible SDK major from package.json', () => {
    expect(sdkMajor).toMatch(/^\d{2,}$/);
  });

  it('names the versioned docs URL for that exact SDK', () => {
    expect(
      `AGENTS.md: ${agents.includes(`https://docs.expo.dev/versions/v${sdkMajor}.0.0/`) ? 'current' : 'STALE'}`
    ).toBe('AGENTS.md: current');
  });

  it('names no OTHER versioned docs URL', () => {
    const pointed = [...agents.matchAll(/docs\.expo\.dev\/versions\/v(\d+)\.\d+\.\d+/g)].map((m) => m[1]);
    expect(pointed.length).toBeGreaterThan(0);
    expect([...new Set(pointed)]).toEqual([sdkMajor]);
  });
});

describe('CLAUDE.md states the versions package.json pins', () => {
  const claude = read('CLAUDE.md');

  it('the SDK & Backend line carries the live SDK, RN and React versions', () => {
    // One sentence, three numbers, all of which went stale together.
    expect(claude).toContain(`**Expo SDK ${sdkMajor}**, React Native ${appRn}, React ${appReact}.`);
  });

  it('no present-tense sentence still names an older Expo SDK', () => {
    // Deliberately narrow. A bare "SDK 57's CLI fixed …" is a true statement about a
    // DIFFERENT release and must stay; what goes stale is the handful of shapes that
    // assert what this app runs on today. All four of these were wrong at once.
    const CLAIMS = [/Expo SDK (\d+)/g, /Expo Go on SDK (\d+)/g, /auto-picks SDK (\d+)/g];
    const found = CLAIMS.flatMap((re) => [...claude.matchAll(re)]).map((m) => ({
      text: m[0],
      major: m[1],
    }));
    expect(found.length).toBeGreaterThanOrEqual(3);
    const stale = found.filter((f) => f.major !== sdkMajor).map((f) => f.text);
    expect(`stale in CLAUDE.md: ${[...new Set(stale)].join(', ') || 'none'}`).toBe(
      'stale in CLAUDE.md: none'
    );
  });
});

describe("metro.config.js's blockList comment still describes the tree", () => {
  const metro = read('metro.config.js');

  it('names the React version the app is on', () => {
    expect(metro).toContain(appReact);
  });

  it('names the React version admin/ pins — the other half of the collision', () => {
    expect(metro).toContain(adminReact);
  });

  it('and admin/ really does pin a different React, or the comment is fiction', () => {
    expect(adminReact).not.toBe(appReact);
  });
});
