// ─────────────────────────────────────────────────────────────────────────────
// A gig can be reported from the FEED, not only from inside it.
//
// Reported 2026-09-06: "There is no button for people to report a job on discovery.
// This can be added to help us pull down bad or fishy jobs." Correct — submitReport
// was reachable from JobDetail, PublicProfile and the chat sheet, and from nowhere on
// the browse card. So the listing a browsing user most wants to flag, the obvious
// scam they are deliberately NOT tapping into, was the one they had to open first.
//
// Three things have to hold for that control to be worth anything, and each has a
// specific way of quietly failing:
//
//   1. The report must carry the JOB. A report with only reported_user_id lands in the
//      queue with no gig attached, and "pull down bad jobs" is then a manual hunt.
//   2. ONE sheet per feed, owned by the screen. A <Modal> inside a FlatList row is one
//      native window per visible card on iOS.
//   3. It must not appear on your own gigs. Nothing in isBrowsable filters them out of
//      the feed, and every non-auto report pages the on-call human
//      (trg_notify_safety_report), so a self-report is a 2am email about nothing.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const card = strip(read('src/components/JobCard.js'));
const home = strip(read('src/screens/HomeScreen.js'));
const sheet = strip(read('src/components/ReportSheet.js'));
const webCard = strip(read('web/components/JobCard.tsx'));
const webBrowse = strip(read('web/app/(app)/browse/page.tsx'));
const modQueue = strip(read('admin/app/(console)/moderation/page.tsx'));

describe('the browse card carries a report control', () => {
  it('mobile: the card takes onReport and renders the control only when given one', () => {
    expect(card).toMatch(/function JobCard\(\{[^}]*onReport[^}]*\}\)/);
    expect(card).toMatch(/\{onReport && \(/);
    expect(card).toMatch(/accessibilityLabel="Report this gig"/);
  });

  it('mobile: the control hands the card its OWN job back', () => {
    // onReport() with no argument leaves the host guessing which row was pressed —
    // in a virtualised list that is the wrong gig, not no gig.
    expect(card).toMatch(/onReport\(job\)/);
  });

  it('web: the same prop, the same gating, the same argument', () => {
    expect(webCard).toMatch(/onReport\?: \(job: Job\) => void/);
    expect(webCard).toMatch(/\{onReport && \(/);
    expect(webCard).toMatch(/onReport\(job\)/);
    expect(webCard).toMatch(/aria-label="Report this gig"/);
  });

  it('both cards reserve room for the second button so it cannot cover the meta line', () => {
    // The action buttons are absolutely positioned; the meta row and the booking pill
    // clear them with a static inset. A second button without a wider inset paints
    // over the category/posted-at line — visible only on a card that has one.
    expect(card).toMatch(/onReport && styles\.headerRowWide/);
    expect(card).toMatch(/onReport && styles\.bookingPillWide/);
    expect(webCard).toMatch(/onReport \? "pr-16" : "pr-7"/);
    expect(webCard).toMatch(/onReport \? "mr-16" : "mr-8"/);
  });
});

describe('the report reaches the moderation queue attached to the gig', () => {
  it.each([
    ['mobile', home],
    ['web', webBrowse],
  ])('%s: submitReport carries jobId AND the poster', (_label, src) => {
    expect(src).toMatch(
      /submitReport\(\{\s*reporterId: user\.id,\s*reportedUserId: job\.posterId,\s*jobId: job\.id,\s*reason\s*\}\)/,
    );
  });

  it.each([
    ['mobile', home],
    ['web', webBrowse],
  ])('%s: the sheet closes BEFORE the await, and the row is captured first', (_label, src) => {
    const i = src.indexOf('doReport');
    const body = src.slice(i, i + 900);
    const capture = body.indexOf('const job = reportJob');
    const close = body.indexOf('setReportJob(null)');
    const send = body.indexOf('submitReport');
    expect(capture).toBeGreaterThan(-1);
    // Clearing state first and reading it after would submit a report about nothing.
    expect(capture).toBeLessThan(close);
    expect(close).toBeLessThan(send);
  });

  it.each([
    ['mobile', home],
    ['web', webBrowse],
  ])("%s: a refusal shows the SERVER's message, not a generic retry", (_label, src) => {
    // guard_report_rate_limit raises check_violation with prose written for the person
    // reading it ("If someone is in danger, contact support or emergency services
    // directly"). Swallowing that for "Please try again" tells a user to retry the one
    // thing that is now guaranteed to fail.
    const i = src.indexOf('doReport');
    const body = src.slice(i, i + 1200);
    expect(body).toMatch(/message: (e\?\.message|msg) \|\| ['"]Please try again\.['"]/);
  });
});

describe('one sheet per feed, not one per row', () => {
  it('mobile: HomeScreen mounts exactly one ReportSheet, outside renderItem', () => {
    expect((home.match(/<ReportSheet/g) || []).length).toBe(1);
    expect(home.indexOf('<ReportSheet')).toBeGreaterThan(home.indexOf('renderItem'));
    expect(card).not.toMatch(/ReportSheet|REPORT_REASONS/);
  });

  it('web: the browse page mounts one report Modal, and the card mounts none', () => {
    expect((webBrowse.match(/title="Report this gig"/g) || []).length).toBe(1);
    expect(webCard).not.toMatch(/REPORT_REASONS/);
  });

  it('mobile: Cancel clears the home indicator and is a real touch target', () => {
    // Both found in the simulator, not in review: with a fixed 32pt bottom padding the
    // Cancel row sat in the home-indicator strip, and as a bare Text in a Touchable it
    // was ~18pt tall — taps 10pt below the glyphs did nothing at all.
    expect(sheet).toMatch(/useSafeAreaInsets\(\)/);
    expect(sheet).toMatch(/paddingBottom: 20 \+ Math\.max\(insets\.bottom, 12\)/);
    expect(sheet).toMatch(/cancel: \{[^}]*minHeight: 44/);
  });

  it('mobile: the sheet is a Modal and draws its reasons from the shared list', () => {
    // Alert.alert caps at three buttons on Android and silently drops the other two
    // reasons — the bug the chat report flow already hit.
    expect(sheet).toMatch(/import \{ REPORT_REASONS \} from '\.\.\/lib\/moderation'/);
    expect(sheet).toMatch(/<Modal visible=\{visible\}/);
    expect(sheet).not.toMatch(/Alert\.alert/);
  });
});

describe('you cannot report your own gig', () => {
  it.each([
    ['mobile', home, 'item'],
    ['web', webBrowse, 'job'],
  ])('%s: onReport is undefined when the poster is the viewer', (_label, src, v) => {
    const re = new RegExp(
      `onReport=\\{${v}\\.posterId && ${v}\\.posterId === user\\?\\.id \\? undefined : setReportJob\\}`,
    );
    expect(src).toMatch(re);
  });

  it.each([
    ['mobile', home],
    ['web', webBrowse],
  ])('%s: the viewer id comes from auth, not from the profile bundle', (_label, src) => {
    // UserContext's placeholder state has no id; a report filed with a missing
    // reporter_id is rejected outright by reports_insert_own.
    expect(src).toMatch(/useAuth\(\)/);
  });
});

describe('the moderator can actually reach the reported gig', () => {
  it('the queue links the gig title to its take-down page', () => {
    // /jobs/[id] is where TakedownControls lives. The title used to be dead text, so
    // the action the report exists to enable meant pasting a uuid into the URL bar.
    expect(modQueue).toMatch(/href=\{`\/jobs\/\$\{r\.job_id\}`\}/);
  });

  it('that page exists and carries take-down', () => {
    const page = read('admin/app/(console)/jobs/[id]/page.tsx');
    expect(page).toMatch(/TakedownControls/);
  });
});
