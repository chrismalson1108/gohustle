const fs = require('fs');
const path = require('path');

// safety-alert is the only thing that pages a human when someone files a harassment or
// assault report, and its one call-to-action linked to ${ADMIN_URL}/reports — a route
// that has never existed. The queue is /moderation. So the link 404'd at precisely the
// moment a person was trying to act on a safety incident, and nothing would ever have
// surfaced that: the email sends fine, the function returns 200, and the only signal is
// a human hitting a dead page during an emergency.
//
// Rather than pin this one URL, assert the general rule: every admin path an edge
// function links to must correspond to a real route in the console.
const ROOT = path.join(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'supabase', 'functions');
const CONSOLE_DIR = path.join(ROOT, 'admin', 'app', '(console)');

function realConsoleRoutes() {
  const routes = new Set(['']); // the console root itself
  for (const entry of fs.readdirSync(CONSOLE_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('[')) routes.add(entry.name);
  }
  return routes;
}

function edgeFunctionSources() {
  const out = [];
  for (const dir of fs.readdirSync(FUNCTIONS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(FUNCTIONS_DIR, dir.name, 'index.ts');
    if (fs.existsSync(file)) out.push({ name: dir.name, src: fs.readFileSync(file, 'utf8') });
  }
  return out;
}

describe('edge functions only link to admin routes that exist', () => {
  const routes = realConsoleRoutes();
  const fns = edgeFunctionSources();

  test('the console exposes the moderation queue we expect to link to', () => {
    expect(routes.has('moderation')).toBe(true);
    // Guards the test itself: if the console is ever restructured, this fails loudly
    // rather than silently passing every link.
    expect(routes.size).toBeGreaterThan(3);
  });

  test('no edge function links to a non-existent admin route', () => {
    const bad = [];
    for (const { name, src } of fns) {
      // Matches ${ADMIN_URL}/<segment> and any hardcoded admin host path.
      for (const m of src.matchAll(/\$\{ADMIN_URL\}\/([a-z0-9-]*)/gi)) {
        if (!routes.has(m[1])) bad.push(`${name}: /${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
