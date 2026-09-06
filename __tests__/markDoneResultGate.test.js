const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// markEarnerDone / markPosterDone return an HONEST boolean: on a rejected write
// they roll back the optimistic patch, show "Couldn't mark done", and return false.
// The comment on that return in JobsContext says it in as many words — "callers gate
// their 'Marked Done!' toast on this".
//
// No mobile caller did. EarnScreen awaited markEarnerDone, threw the result away, then
// credited the weekly-earnings challenge by the gig's value, fired a success haptic,
// printed "Marked Done!" directly beneath the failure toast, and cleared the finish
// sheet — which orphaned the completion photos that had already uploaded, attaching
// them to nothing, while the booking stayed un-done. GigsScreen and the legacy
// ManageBookingsScreen did the same for markPosterDone, and both fired their success
// haptic BEFORE the write was even attempted. Web's my-jobs page already gated
// (`const ok = await markEarnerDone(...); if (!ok) return;`).
//
// The supabase update returns `{ error }` rather than throwing, so the surrounding
// try/catch never fires for this case — the boolean is the only signal there is.
//
// Asserted at the source level over every screen, so a new call site cannot drop it.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const SCREENS = path.join(ROOT, 'src', 'screens');
const FNS = ['markEarnerDone', 'markPosterDone', 'markJobComplete'];

/** Every `<fn>(` call that is not the destructured import or the definition. */
function callSites(src, fn) {
  const out = [];
  const re = new RegExp(`[^\\w.]${fn}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const line = src.slice(lineStart, src.indexOf('\n', m.index));
    if (/^\s*(?:\/\/|\*)/.test(line)) continue;   // a mention in a comment
    out.push({ line: line.trim(), index: m.index });
  }
  return out;
}

const screens = fs.readdirSync(SCREENS)
  .filter(f => f.endsWith('.js'))
  .map(f => ({ file: f, src: fs.readFileSync(path.join(SCREENS, f), 'utf8') }));

const sites = [];
screens.forEach(({ file, src }) => {
  FNS.forEach(fn => callSites(src, fn).forEach(s => sites.push({ file, fn, ...s, src })));
});

describe('mark-done callers gate on the returned boolean', () => {
  it('the context still returns false on a rejected write', () => {
    const ctx = fs.readFileSync(path.join(ROOT, 'src', 'context', 'JobsContext.js'), 'utf8');
    // Two functions, each with a rollback + toast + `return false` on error.
    const falses = ctx.match(/showToast\(\{ icon: '⚠️', title: "Couldn't mark done"[\s\S]{0,320}?return false;/g);
    expect(falses).not.toBeNull();
    expect(falses.length).toBe(2);
  });

  it('found the call sites', () => {
    // EarnScreen + GigsScreen at least; ManageBookingsScreen is the legacy third.
    expect(sites.length).toBeGreaterThanOrEqual(2);
    expect(sites.map(s => s.file)).toEqual(expect.arrayContaining(['EarnScreen.js', 'GigsScreen.js']));
  });

  sites.forEach(({ file, fn, line, index, src }) => {
    it(`${file} captures ${fn}'s result`, () => {
      expect(line).toMatch(new RegExp(`=\\s*await\\s+${fn}\\(`));
    });

    it(`${file} checks it before claiming success`, () => {
      // The check must come before anything that tells the user it worked.
      const after = src.slice(index, index + 700);
      const check = after.search(/if \(ok === false\)/);
      expect(check).toBeGreaterThan(-1);
      const success = after.search(/haptic\.success\(\)|Marked Done!|Job Complete!/);
      if (success > -1) expect(check).toBeLessThan(success);
    });
  });

  it("EarnScreen does not credit the challenge for a write that didn't land", () => {
    const src = fs.readFileSync(path.join(SCREENS, 'EarnScreen.js'), 'utf8');
    const at = src.indexOf('await markEarnerDone(');
    const credit = src.indexOf("updateChallenge('c2'", at);
    const gate = src.indexOf('if (ok === false)', at);
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(credit);
  });
});
