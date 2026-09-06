const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─────────────────────────────────────────────────────────────────────────────
// The admin console has no git integration. The ONLY way it ships is a human
// running the Vercel CLI by hand, so the command as printed in a document is the
// deploy mechanism — a wrong one leaves admin.gohustlr.com serving the last
// hand-made build indefinitely, which is exactly the 7-days-stale condition
// DEPLOY.md itself warns about.
//
// Two halves of that command are load-bearing, and until 2026-09-06 the two
// documents an operator would actually open each dropped one:
//
//   --scope go-hustlr  — `gohustlr-admin` belongs to the go-hustlr TEAM while the
//     CLI signs in as the personal account `mainmail-1145`. Without it the deploy
//     fails with a flat "Not authorized" / deploy_failed, which reads like an
//     expired login; the obvious response (re-authenticate) fixes nothing.
//     DEPLOY.md:15 printed `cd admin && npx vercel --prod`.
//
//   cd admin — the CLI picks its project from the `.vercel/` link in the directory
//     it runs in, and the repo root's link is `gohustle`, the WEBSITE. admin/README.md
//     said the deploy "works from the repo root" because the project's Root Directory
//     is admin/ — true of the project, irrelevant to which project the CLI resolves.
//     Run from there it deploys the website and prints a success URL.
//
// CLAUDE.md and .githooks/pre-push already had both. This test is what stops the
// documents drifting apart from them again.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');

// The two registers quote broken commands verbatim as evidence — that is their job,
// and rewriting a historical finding would destroy the record.
const EXEMPT = new Set(['OPEN_WORK.md', 'KNOWN_RISKS.md']);

const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

// .html is in here for docs/audits/2026-08-12-payments/remediation-plan.html — a
// rendered runbook that carries the same deploy line as its markdown siblings, and
// would otherwise be the one copy nothing checks.
const scanned = tracked.filter(
  (f) =>
    (f.endsWith('.md') || f.endsWith('.html') || f.startsWith('.githooks/')) &&
    !EXEMPT.has(path.basename(f))
);

// A line that shows someone a production Vercel deploy.
const DEPLOY_LINE = /vercel[^\n]*--prod/;

const deployLines = [];
scanned.forEach((file) => {
  const abs = path.join(ROOT, file);
  if (!fs.statSync(abs).isFile()) return;
  fs.readFileSync(abs, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (DEPLOY_LINE.test(line)) deployLines.push({ file, line: i + 1, text: line.trim() });
    });
});

// A deploy line is about the console when it names admin, or when it lives in the
// console's own README — where every deploy command is by definition the console's.
const adminLines = deployLines.filter(
  (d) => /admin/i.test(d.text) || d.file === 'admin/README.md'
);

describe('every documented admin-console deploy command is runnable as written', () => {
  it('finds the commands to check', () => {
    // Guards against the scan silently matching nothing and passing vacuously.
    expect(adminLines.length).toBeGreaterThanOrEqual(5);
  });

  it('carries --scope go-hustlr on every one', () => {
    const missing = adminLines
      .filter((d) => !d.text.includes('--scope go-hustlr'))
      .map((d) => `${d.file}:${d.line}  ${d.text}`);
    expect(
      missing.length
        ? `these deploy the console without the team scope and fail "Not authorized":\n${missing.join('\n')}`
        : 'all scoped'
    ).toBe('all scoped');
  });

  it("runs from admin/, not the repo root whose .vercel link is the website", () => {
    const readme = fs.readFileSync(path.join(ROOT, 'admin/README.md'), 'utf8');
    const cmd = readme.split('\n').find((l) => DEPLOY_LINE.test(l));
    expect(cmd).toBeDefined();
    expect(cmd).toMatch(/cd admin/);
    // And the claim that justified running it from the repo root must be gone.
    expect(readme).not.toMatch(/so this works from the repo root/);
  });

  it('agrees with the pre-push hook, which was right all along', () => {
    const hook = fs.readFileSync(path.join(ROOT, '.githooks/pre-push'), 'utf8');
    expect(hook).toContain('cd admin && npx vercel --prod --scope go-hustlr');
  });
});
