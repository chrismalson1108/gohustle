const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// A screen whose native nav bar already says "Security" must not also print
// "Security" underneath it.
//
// Chris has now flagged this three times — Transactions, then Security, then
// Profile settings — because I keep writing screens the way a web page is written,
// where there IS no nav bar to carry the title. On a pushed screen the bar is right
// there next to the back chevron, so the in-screen heading is pure repetition AND it
// costs the most valuable band of the screen: the part visible without scrolling.
//
// A SUBTITLE is fine and often useful — it says something the bar cannot fit. What
// is banned is repeating the title itself.
//
// Parsed from App.js so it covers every screen automatically, including ones added
// later that nobody thought to check.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'App.js'), 'utf8');

// <Stack.Screen name="X" component={Y} options={{ ...DETAIL_OPTS, title: 'Z' }} />
const RE = /<Stack\.Screen\s+name="([A-Za-z]+)"\s+component=\{([A-Za-z]+)\}[^>]*?title:\s*'([^']+)'/g;

const screens = [];
const seen = new Set();
let m;
while ((m = RE.exec(app))) {
  const [, route, component, title] = m;
  // Tab stacks carry a title for the tab bar, not a pushed nav bar.
  if (/Stack$/.test(component)) continue;
  // Shared screens are registered in several stacks; check each once.
  if (seen.has(component)) continue;
  seen.add(component);
  const file = path.join(ROOT, 'src', 'screens', `${component}.js`);
  if (fs.existsSync(file)) screens.push({ route, component, title, file });
}

// Only the <ScreenHeader> block counts. The title appearing elsewhere is usually
// load-bearing — SupportScreen stamps "GoHustlr Support" on every agent message
// bubble, which is the attribution that makes a staff reply identifiable and must
// never be removed. Scoping to the header is what makes this test safe to trust.
function headerBlock(src) {
  const open = src.indexOf('<ScreenHeader');
  if (open === -1) return '';
  const close = src.indexOf('</ScreenHeader>', open);
  return close === -1 ? '' : src.slice(open, close);
}

describe('no screen prints its own nav-bar title twice', () => {
  it('found screens to check', () => {
    expect(screens.length).toBeGreaterThan(3);
  });

  screens.forEach(({ component, title, file }) => {
    it(`${component} does not repeat "${title}"`, () => {
      const src = headerBlock(fs.readFileSync(file, 'utf8'));
      // A <Text> whose entire content is the nav title. Deliberately narrow: a title
      // appearing inside a sentence, a button label, or an accessibility string is
      // not the duplication being caught here.
      const dup = new RegExp(`<Text[^>]*>\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</Text>`, 'i');
      expect(`${component}: ${dup.test(src) ? 'DUPLICATE TITLE' : 'ok'}`).toBe(`${component}: ok`);
    });
  });
});
