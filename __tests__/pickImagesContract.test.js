// ─────────────────────────────────────────────────────────────────────────────
// pickImages() / pickImage() return an OBJECT. Two call sites read it as an array.
//
// src/lib/uploadImage.js has resolved to { canceled } / { canceled, denied } /
// { canceled: false, uris: [...] } since the file was written — it is even
// documented in the comment above the export. But SupportScreen and
// CompletionModal both did:
//
//     const res = await pickImages({ multiple: true });
//     if (res?.length) setPhotos(prev => [...prev, ...res].slice(0, 6));
//
// An object has no `length`, so the condition was `undefined` on every outcome
// and the setter never ran. Both features were structurally dead:
//
//  · Support: a user picking a photo for a "Safety or harassment" report sent a
//    text-only ticket. The agent opens a safety thread with no evidence and has
//    to go back and ask for it. The whole downstream path — owner-scoped upload,
//    `images: paths`, support-submit storage, the ticket-scoped read policy —
//    was built and hardened on 2026-08-14 for photos that could never arrive.
//    __tests__/supportAttachments.test.js guards that the screen PASSES what it
//    uploaded, and passed the whole time, because nothing asserted the state it
//    passes could ever be non-empty.
//  · CompletionModal: the poster's dispute evidence, guarded separately by
//    __tests__/disputeEvidencePicker.test.js.
//
// Two independent screens made the same mistake against the same helper, so the
// guard belongs on the CONTRACT rather than on either screen: this walks every
// call site under src/ and fails if the result is consumed as an array.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.isFile() && /\.jsx?$/.test(e.name) ? [p] : [];
  });
}

// Every `const <var> = await pickImage(s)(…)` under src/, paired with the source
// that follows it — up to the next pick call, so two handlers in one file cannot
// cover for each other.
const CALLS = walk(SRC)
  .filter((p) => p !== path.join(SRC, 'lib', 'uploadImage.js'))
  .flatMap((p) => {
    const src = fs.readFileSync(p, 'utf8');
    const re = /(?:const|let)\s+(\w+)\s*=\s*await\s+(pickImages|pickImage)\s*\(/g;
    const out = [];
    let m;
    while ((m = re.exec(src)) !== null) {
      const next = src.indexOf('= await pick', m.index + m[0].length);
      const end = Math.min(next === -1 ? src.length : next, m.index + 900);
      out.push({
        file: path.relative(ROOT, p),
        line: src.slice(0, m.index).split('\n').length,
        variable: m[1],
        fn: m[2],
        body: src.slice(m.index, end),
      });
    }
    return out;
  });

const label = (c) => `${c.file}:${c.line} (${c.fn})`;

describe('the helper really does return an object on every path', () => {
  const uploader = fs.readFileSync(path.join(SRC, 'lib', 'uploadImage.js'), 'utf8');

  it('never resolves to an array', () => {
    const returns = uploader.match(/return \{ canceled[^}]*\};/g) || [];
    expect(returns.length).toBeGreaterThanOrEqual(3);
    expect(uploader).toMatch(/Returns \{ canceled, denied, uris \}/);
    // pickImage narrows the plural to a single `uri` — the other shape callers read.
    expect(uploader).toMatch(/return res\.canceled \? res : \{ canceled: false, denied: false, uri: res\.uris\[0\] \}/);
  });
});

describe('every caller consumes that object as an object', () => {
  it('the walker actually found the call sites', () => {
    // A regex that matches nothing would make every assertion below vacuous.
    expect(CALLS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(CALLS.map((c) => c.file)).size).toBeGreaterThanOrEqual(7);
  });

  it('branches on .canceled', () => {
    const bad = CALLS.filter((c) => !new RegExp(`\\b${c.variable}\\.canceled\\b`).test(c.body));
    expect(bad.map(label)).toEqual([]);
  });

  it('never tests .length on the result', () => {
    // The exact shape of both bugs: `if (res?.length)`.
    const bad = CALLS.filter((c) => new RegExp(`\\b${c.variable}\\??\\.length\\b`).test(c.body));
    expect(bad.map(label)).toEqual([]);
  });

  it('never spreads the result as if it were the array of uris', () => {
    const bad = CALLS.filter((c) => new RegExp(`\\.\\.\\.${c.variable}\\s*[\\]),]`).test(c.body));
    expect(bad.map(label)).toEqual([]);
  });

  it('reads .uris from pickImages and .uri from pickImage', () => {
    const bad = CALLS.filter((c) => {
      const want = c.fn === 'pickImages'
        ? new RegExp(`\\b${c.variable}\\.uris\\b`)
        : new RegExp(`\\b${c.variable}\\.uri\\b`);
      return !want.test(c.body);
    });
    expect(bad.map(label)).toEqual([]);
  });
});

describe("the support thread's photos now have somewhere to come from", () => {
  const screen = fs.readFileSync(path.join(SRC, 'screens', 'SupportScreen.js'), 'utf8');

  it('the picker fills the state that send() uploads', () => {
    const handler = screen.slice(screen.indexOf('const addPhotos = async'), screen.indexOf('const send = async'));
    expect(handler).toMatch(/setPhotos\(prev => \[\.\.\.prev, \.\.\.res\.uris\]\.slice\(0, 6\)\)/);
    expect(handler).toMatch(/Photos access needed/);
    expect(screen).toMatch(/uris: photos, bucket: 'support-photos'/);
  });

  it('and that state was genuinely unreachable before, not merely unused', () => {
    // photos[] gates the upload, the thumbnail strip and the photo-only send —
    // all three were dead behind the same never-true condition.
    expect(screen).toMatch(/if \(photos\.length && user\?\.id\)/);
    expect(screen).toMatch(/\(!body && photos\.length === 0\) \|\| sending/);
  });
});
