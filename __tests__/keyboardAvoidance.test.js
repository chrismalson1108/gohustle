// ─────────────────────────────────────────────────────────────────────────────
// A bottom sheet with a text field in it must move out from under the keyboard.
//
// Reported 2026-08-17: "when rating a poster I can't see what I'm typing." The rate
// sheet in JobDetailScreen is bottom-anchored and the note field sits below the stars,
// so on iOS the keyboard covered the exact thing being typed into. EarnScreen's rate
// sheet — the SAME flow, written once and then copied without this — has had a
// KeyboardAvoidingView since it was written.
//
// ── THE TWO MECHANISMS ARE NOT INTERCHANGEABLE ──────────────────────────────
// The app has both and they solve different problems, which is how this hid:
//
//   KeyboardDoneBar          DISMISSES the keyboard. For multiline and numeric inputs
//                            that have no return key, so there is a way to close it.
//   KeyboardAvoidingView     Stops the keyboard COVERING the input in the first place.
//
// JobDetailScreen had the first and not the second, so the keyboard could be dismissed
// but never got out of the way. "It already handles the keyboard" was true and useless.
//
// The screen-body half of the pair — automaticallyAdjustKeyboardInsets on the scrolling
// content — is deliberately NOT asserted here: a search field at the top of a screen is
// above the keyboard and needs nothing, so a blanket rule would be false positives.
// A modal with a text field is unambiguous, which is why this test draws the line there.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Comments quote the failure verbatim — this repo's own fix notes name every symbol
// asserted on below. Matching prose is how a test ends up checking its own explanation.
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Every <Modal …> … </Modal> block in a file, as source text. */
function modalBlocks(src) {
  const blocks = [];
  let from = 0;
  for (;;) {
    const open = src.indexOf('<Modal', from);
    if (open === -1) break;
    const close = src.indexOf('</Modal>', open);
    if (close === -1) break;
    blocks.push(src.slice(open, close));
    from = close + 1;
  }
  return blocks;
}

describe('a modal containing a text field avoids the keyboard', () => {
  const offenders = [];
  const checked = [];

  for (const file of walk(SRC)) {
    const src = codeOnly(fs.readFileSync(file, 'utf8'));
    for (const [i, block] of modalBlocks(src).entries()) {
      if (!/<TextInput/.test(block)) continue;
      const rel = path.relative(path.join(__dirname, '..'), file);
      checked.push(`${rel} #${i + 1}`);
      // KeyboardDoneBar does NOT count. It dismisses; it does not move anything.
      if (!/<KeyboardAvoidingView/.test(block)) offenders.push(`${rel} modal #${i + 1}`);
    }
  }

  it('found modals to check, so this is not passing vacuously', () => {
    // Without this the whole suite goes green the day the parser stops matching.
    expect(checked.length).toBeGreaterThanOrEqual(5);
  });

  it('every one of them wraps in KeyboardAvoidingView', () => {
    expect(offenders).toEqual([]);
  });
});

describe('the two rate sheets agree with each other', () => {
  // They are the same flow rendered twice — JobDetail for the earner arriving from a
  // gig, EarnScreen from the hub. One of them drifting is what produced the bug.
  const read = (p) => codeOnly(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
  const sheets = {
    'JobDetailScreen': read('src/screens/JobDetailScreen.js'),
    'EarnScreen': read('src/screens/EarnScreen.js'),
  };

  for (const [name, src] of Object.entries(sheets)) {
    it(`${name} imports KeyboardAvoidingView and applies the iOS behavior`, () => {
      expect(src).toMatch(/KeyboardAvoidingView/);
      // behavior must be set — an unset behavior on iOS is a no-op, so the component
      // renders, the test would pass, and the keyboard still covers the field.
      expect(src).toMatch(/behavior=\{Platform\.OS === 'ios' \? 'padding' : undefined\}/);
    });
  }
});

describe('screens whose code fields sit below the fold adjust for the keyboard', () => {
  const read = (p) => codeOnly(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));

  it('SecurityScreen scrolls its verify and disable cards clear', () => {
    // Both cards render BELOW the status card, so on a short screen the 6-digit field
    // was under the keyboard. Not a modal, so the rule above does not reach it.
    const src = read('src/screens/SecurityScreen.js');
    expect(src).toMatch(/automaticallyAdjustKeyboardInsets/);
  });

  it('JobDetailScreen keeps it on the body too, for the counter-offer and note fields', () => {
    // Those two are in the page body rather than a sheet, and were already correct —
    // asserted so a future edit cannot quietly drop them while fixing something else.
    const src = read('src/screens/JobDetailScreen.js');
    expect(src).toMatch(/automaticallyAdjustKeyboardInsets/);
  });
});
