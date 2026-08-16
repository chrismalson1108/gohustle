const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// OPEN_WORK.md is the backlog that outlives a session.
//
// Two audits this week produced 108 confirmed findings between them. One set lived
// only inside a Claude session transcript; the other lived in a file under /tmp. Both
// were invisible to the next session, which is exactly how "we fixed x and y" becomes
// "z never got done" — and how Chris ends up having to remember what is outstanding.
//
// The register only works if it stays machine-readable, so this asserts the shape
// rather than trusting it to stay tidy.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const doc = fs.readFileSync(path.join(ROOT, 'OPEN_WORK.md'), 'utf8');

describe('the open-work register is usable by a future session', () => {
  it('declares how many items are open, and the count matches the rows', () => {
    // A header that disagrees with the table is how a backlog starts lying.
    const m = doc.match(/## Open \((\d+)\)/);
    expect(m).not.toBeNull();
    const declared = Number(m[1]);
    const section = doc.slice(doc.indexOf('## Open ('), doc.indexOf('## Closed ('));
    const rows = section.split('\n').filter((l) => /^\| (critical|high|medium|low|gated) \|/.test(l));
    expect(`declared ${declared} / rows ${rows.length}`).toBe(`declared ${declared} / rows ${declared}`);
  });

  it('every open row carries a severity we act on', () => {
    // `gated` was added 2026-08-14 and is deliberately NOT a severity — it means the row
    // is blocked on a business decision or a milestone, not on work. The live-mode Stripe
    // webhook sat as `high` for two days while being entirely correct: the platform is on
    // sandbox and go-live is not scheduled, so there was nothing to do. A high row nobody
    // can action reads as neglect and trains people to skim the severity column, which
    // costs more than the row it mislabels.
    //
    // A gated row must SAY what it is waiting on, or it is just a high row in a costume.
    const section = doc.slice(doc.indexOf('## Open ('), doc.indexOf('## Closed ('));
    const rows = section.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Sev') && !l.startsWith('|---'));
    rows.forEach((r) => {
      expect(r).toMatch(/^\| (critical|high|medium|low|gated) \|/);
      if (r.startsWith('| gated |')) {
        expect(`${r.slice(0, 70)}…`).toMatch(/gated/);
        expect(r).toMatch(/NOT A DEFECT|waiting on|gate\b|not scheduled|decision/i);
      }
    });
  });

  it('tells a session to work it without being asked', () => {
    // The instruction is the whole point — a list nobody is told to act on is a list
    // nobody acts on.
    expect(doc).toMatch(/this is your backlog/i);
    expect(doc).toMatch(/Do not wait to be asked/i);
  });

  it('records the audits whose findings are not yet transcribed', () => {
    // The payments register still lives in a transcript; forgetting that is the same
    // failure one level up.
    expect(doc).toMatch(/LIVE \/ DORMANT/);
  });

  it('is referenced from CLAUDE.md, which is what every session actually reads', () => {
    const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('OPEN_WORK.md');
  });
});
