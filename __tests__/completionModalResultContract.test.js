const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// CompletionModal's onConfirm contract: an explicit `false` means "the verify
// aborted — stay open so the poster can edit and retry". ANYTHING else closes the
// sheet, and the sheet resets rating/review/tip/dispute on its next `visible`, so a
// close on an abort silently destroys everything the poster typed.
//
// GigsScreen.handleVerify checked verifyAndRate's false result to suppress the
// success toast and then fell off the end of the function — resolving to `undefined`,
// which the modal read as success. The poster whose review tripped findProhibited got
// "Review not allowed — please edit it and try again" and then watched the sheet, the
// review, the four stars and the $10 tip disappear, with the booking still unverified.
// Same for the "Payment not found" and "already finalized" aborts.
//
// A bare `return;` in one of these handlers is therefore a bug, not a style choice.
// This asserts the shape at the source level for every screen that hosts the modal,
// so a new host cannot reintroduce it.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const SCREENS = path.join(ROOT, 'src', 'screens');

/** Body of `const <name> = async (...) => { ... }`, brace-matched. */
function fnBody(src, name) {
  const decl = new RegExp(`const\\s+${name}\\s*=\\s*async\\s*\\([^)]*\\)\\s*=>\\s*\\{`);
  const m = decl.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  return src.slice(m.index, i);
}

const hosts = fs.readdirSync(SCREENS)
  .filter(f => f.endsWith('.js'))
  .map(f => ({ file: f, src: fs.readFileSync(path.join(SCREENS, f), 'utf8') }))
  .filter(({ src }) => src.includes('<CompletionModal'))
  .map(({ file, src }) => {
    const m = /<CompletionModal[\s\S]*?onConfirm=\{(\w+)\}/.exec(src);
    return { file, src, handler: m && m[1] };
  });

describe('CompletionModal onConfirm handlers return a boolean', () => {
  it('found the screens that host the modal', () => {
    // GigsScreen (live) + ManageBookingsScreen (legacy, still registered).
    expect(hosts.length).toBeGreaterThanOrEqual(2);
    expect(hosts.map(h => h.file)).toContain('GigsScreen.js');
  });

  it('the modal still only stays open on an explicit false', () => {
    const modal = fs.readFileSync(path.join(ROOT, 'src', 'components', 'CompletionModal.js'), 'utf8');
    // If this ever changes, the handler contract below changes with it.
    expect(modal).toMatch(/const ok = await onConfirm\(\{[\s\S]*?\}\);\s*(?:\/\/[^\n]*\n\s*)*if \(ok === false\) return;\s*onClose\(\);/);
  });

  hosts.forEach(({ file, src, handler }) => {
    describe(`${file} → ${handler}`, () => {
      const body = handler && fnBody(src, handler);

      it('the handler is a findable async function', () => {
        expect(handler).toBeTruthy();
        expect(body).toBeTruthy();
      });

      it('has no bare `return;` — undefined reads as success and closes the sheet', () => {
        expect(body).not.toMatch(/\breturn\s*;/);
      });

      it('propagates verifyAndRate\'s result rather than swallowing it', () => {
        // Either `return await verifyAndRate(...)` directly, or capture-and-return.
        const propagates =
          /return\s+(?:await\s+)?verifyAndRate\(/.test(body)
          || (/=\s*await verifyAndRate\(/.test(body) && /if \(ok === false\) return false;/.test(body));
        expect(propagates).toBe(true);
      });
    });
  });
});
