// ─────────────────────────────────────────────────────────────────────────────
// An avatar or a gig photo may only be an image in OUR storage, under the writer.
//
// profiles.avatar_url and jobs.photos were owner-writable free text with nothing
// validating them: guard_profiles_write (20260722020000) pins trust, money and
// moderation columns and never mentions avatar_url; guard_jobs_write (20260726110000)
// pins the core terms while booked and never mentions photos; there is no CHECK on
// either. So one `PATCH /rest/v1/profiles?id=eq.<me>
// {"avatar_url":"https://attacker.tld/x.jpg"}` put an arbitrary external image beside
// every gig that user posted, in every chat row they sent, and on their public profile —
// never scanned, because moderate-image takes a (bucket, path) and can only ever look at
// objects that were actually uploaded — while handing the attacker's host the IP and
// user-agent of every viewer, on a platform used by minors.
//
// The repo had already recognised this class and closed it for ONE column:
// safeCertUrl, on certifications.image_url ("attacker-controllable via a direct API
// insert (RLS only checks ownership) … blocks an off-platform phishing link or
// tracking-pixel"). The two most visible columns never got the same rule.
//
// Two halves, deliberately different strengths:
//   * 20260906014100 refuses the WRITE, pinning the exact project origin — anyone can
//     create a Supabase project, so `*.supabase.co` would not be a fence.
//   * safeStorageUrl refuses the RENDER, which is what covers rows written earlier. It
//     has no project constant to compare against, so it checks the shape and the
//     supabase.co host and leaves the exact-origin rule where it can be asserted.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { safeStorageUrl, transformJob } = require('../shared/transforms.js');

const ROOT = path.join(__dirname, '..');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PROJECT = 'https://nfioebqsgmmzhbksxozc.supabase.co';
const OWN_AVATAR = `${PROJECT}/storage/v1/object/public/avatars/6f1b0c22-0000-4000-8000-000000000001/1.jpg`;
const OWN_PHOTO = `${PROJECT}/storage/v1/object/public/job-photos/6f1b0c22-0000-4000-8000-000000000001/1.jpg`;

describe('safeStorageUrl', () => {
  it('passes a genuine getPublicUrl object — the shape both uploaders produce', () => {
    expect(safeStorageUrl(OWN_AVATAR, 'avatars')).toBe(OWN_AVATAR);
    expect(safeStorageUrl(OWN_PHOTO, 'job-photos')).toBe(OWN_PHOTO);
  });

  it('drops an arbitrary external image', () => {
    expect(safeStorageUrl('https://attacker.tld/explicit.jpg', 'avatars')).toBeNull();
  });

  it('drops our path shape served from someone else’s host', () => {
    // The URL a `pathname.includes('/storage/v1/object/public/')` test would accept.
    expect(safeStorageUrl(
      'https://attacker.tld/storage/v1/object/public/avatars/x/1.jpg', 'avatars',
    )).toBeNull();
  });

  it('drops a different bucket, so a private-bucket path cannot be laundered here', () => {
    expect(safeStorageUrl(OWN_PHOTO, 'avatars')).toBeNull();
    expect(safeStorageUrl(OWN_AVATAR, 'job-photos')).toBeNull();
  });

  it('drops plain http, a javascript: url, a bare path and junk', () => {
    expect(safeStorageUrl(OWN_AVATAR.replace('https:', 'http:'), 'avatars')).toBeNull();
    expect(safeStorageUrl('javascript:alert(1)', 'avatars')).toBeNull();
    expect(safeStorageUrl('6f1b0c22/1.jpg', 'avatars')).toBeNull();
    expect(safeStorageUrl('not a url', 'avatars')).toBeNull();
    expect(safeStorageUrl(null, 'avatars')).toBeNull();
    expect(safeStorageUrl('', 'avatars')).toBeNull();
  });

  it('drops a bucket root with no object after it', () => {
    expect(safeStorageUrl(`${PROJECT}/storage/v1/object/public/avatars/`, 'avatars')).toBeNull();
  });
});

describe('the jobs feed never carries an off-platform image', () => {
  const row = {
    id: 'j1', poster_id: 'p1', title: 'x', category: 'Odd Jobs', pay: 10, pay_type: 'flat',
    photos: ['https://attacker.tld/tracking-pixel.jpg', OWN_PHOTO],
    profiles: { name: 'P', avatar_initial: 'P', avatar_url: 'https://attacker.tld/pixel.jpg' },
  };

  it('drops an external gig photo and keeps the real one', () => {
    expect(transformJob(row).photos).toEqual([OWN_PHOTO]);
  });

  it('drops an external poster avatar rather than rendering it on every card', () => {
    expect(transformJob(row).poster.avatarUrl).toBeNull();
  });

  it('leaves a clean row exactly as it was', () => {
    const clean = { ...row, photos: [OWN_PHOTO], profiles: { ...row.profiles, avatar_url: OWN_AVATAR } };
    expect(transformJob(clean).photos).toEqual([OWN_PHOTO]);
    expect(transformJob(clean).poster.avatarUrl).toBe(OWN_AVATAR);
  });
});

describe('both Avatar components filter before rendering', () => {
  // Avatar is the choke point: most screens pass profiles.avatar_url straight into it,
  // not through transformJob, so a check that lived only in the transform would miss
  // the profile, chat, review and people-search surfaces.
  it('mobile Avatar renders the filtered url, never the raw prop', () => {
    const src = read('src/components/Avatar.js');
    expect(src).toMatch(/safeStorageUrl\(url, 'avatars'\)/);
    expect(src).toMatch(/source=\{\{ uri: safeUrl \}\}/);
    expect(src).not.toMatch(/source=\{\{ uri: url \}\}/);
  });

  it('web Avatar renders the filtered url, never the raw prop', () => {
    const src = read('web/components/ui/Avatar.tsx');
    expect(src).toMatch(/safeStorageUrl\(url, "avatars"\)/);
    expect(src).toMatch(/<img src=\{safe\}/);
    expect(src).not.toMatch(/<img src=\{url\}/);
  });
});

describe('the write is refused at the database, not only at the render', () => {
  const file = '20260906014100_image_urls_must_be_the_owners_storage_object.sql';
  const sql = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');

  it('guards both columns with a trigger scoped to that column', () => {
    expect(sql).toMatch(/before insert or update of avatar_url on public\.profiles/);
    expect(sql).toMatch(/before insert or update of photos on public\.jobs/);
  });

  it('pins the PROJECT origin, not any supabase.co host, and not a contains-test', () => {
    // `*.supabase.co` is not a fence: anyone can create a project and serve a beacon
    // from it. And a contains-test on the path matches an attacker's own host.
    expect(sql).toContain('storage_public_origin');
    expect(sql).toMatch(/left\(p_value, length\(v_prefix\)\) = v_prefix/);
    expect(sql).not.toMatch(/like '%\/storage\/v1\/object\/public\/%'/);
  });

  it('resolves the owner from OLD on update, the 20260726060000 lesson', () => {
    // trg_guard_job_photo_urls sorts before trg_guard_jobs_write, so new.poster_id is
    // still whatever the client sent when this runs.
    expect(sql).toMatch(/coalesce\(old\.poster_id, new\.poster_id\)/);
    expect(sql).toMatch(/coalesce\(old\.id, new\.id\)/);
  });

  it('exempts service_role, like both sibling path guards', () => {
    expect(sql.match(/auth\.role\(\), ''\) = 'service_role'/g)).toHaveLength(2);
  });

  it('proves itself broken-then-fixed on the same row, and that real writes still pass', () => {
    // The probe drops both triggers, lands the external URL on live tables, restores
    // them, and shows the identical PATCH now raises — then writes the exact shape
    // uploadImage.js produces, because a fix that took avatars away from every user
    // would otherwise look like a pass.
    expect(sql).toContain('PRE-FIX:');
    expect(sql).toContain('FIX BROKE THE APP');
    expect(sql).toContain('probe complete — rolling back');
  });
});
