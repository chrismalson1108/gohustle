// scripts/seed-dallas.mjs
// Seeds Dallas test data into the GoHustlr Supabase project as service_role.
// Idempotent: re-running reuses existing seed users (matched by email).
//
//   SUPABASE_SERVICE_ROLE_KEY=<service_role secret> node scripts/seed-dallas.mjs
//
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'node:fs';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nfioebqsgmmzhbksxozc.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_KEY) { console.error('Set SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }

const SEED_DOMAIN   = 'seed.gohustlr.test';  // reserved tag — teardown keys off this
const SEED_PASSWORD = 'SeedPass!2026';       // test-only; all seed accounts share it
const DOB_ADULT     = '1994-03-15';          // clearly 18+ so guard_min_age never blocks

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Seed data definitions ─────────────────────────────────────────────────────
// Keep all free text clean of moderation terms (Gotcha 3). All coords are Dallas.
const USERS = [
  { key: 'dana',   email: `dana.poster@${SEED_DOMAIN}`,   name: 'Dana Reyes',
    role: 'both',   city: 'Dallas, TX', bio: 'Property manager in Uptown. Posts moving and cleaning gigs.',
    skills: ['Organizing','Scheduling'], rating: 4.9, review_count: 22, poster_rating: 4.9,
    poster_review_count: 18, xp: 1400, verified: true },
  { key: 'marcus', email: `marcus.poster@${SEED_DOMAIN}`, name: 'Marcus Hill',
    role: 'poster', city: 'Plano, TX',  bio: 'Small business owner near Legacy West.',
    skills: [], rating: 4.7, review_count: 9, poster_rating: 4.7, poster_review_count: 9,
    xp: 600, verified: false },
  { key: 'priya',  email: `priya.earner@${SEED_DOMAIN}`,  name: 'Priya Nair',
    role: 'earner', city: 'Dallas, TX', bio: 'Reliable, own truck, weekends free.',
    skills: ['Moving','Heavy Lifting','Cleaning'], rating: 4.95, review_count: 31, xp: 2600, verified: true },
  { key: 'leo',    email: `leo.earner@${SEED_DOMAIN}`,    name: 'Leo Martins',
    role: 'earner', city: 'Irving, TX', bio: 'Handyman + yard work. Fast responder.',
    skills: ['Handyman','Yard Work','Assembly'], rating: 4.6, review_count: 12, xp: 900, verified: false },
  { key: 'sam',    email: `sam.earner@${SEED_DOMAIN}`,    name: 'Sam Okafor',
    role: 'earner', city: 'Dallas, TX', bio: 'New to GoHustlr, eager to help.',
    skills: ['Delivery','Errands'], rating: 5.0, review_count: 2, xp: 150, verified: false },
];

const JOBS = [
  { posterKey: 'dana', title: 'Help move a 1-bed apartment in Uptown', category: 'Moving',
    pay: 140, pay_type: 'flat', location: 'Uptown, Dallas, TX', estimated_hours: 3, urgent: true,
    lat: 32.7942, lng: -96.8016,
    description: 'Two movers needed Saturday morning. Elevator building, no piano. Truck provided.',
    slots: ['Sat 9:00 AM', 'Sat 1:00 PM'], requirements: ['Can lift 50 lbs', 'Comfortable on stairs'] },
  { posterKey: 'dana', title: 'Deep clean a 2-bed after tenant move-out', category: 'Cleaning',
    pay: 25, pay_type: 'hourly', location: 'Oak Cliff, Dallas, TX', estimated_hours: 4, urgent: false,
    lat: 32.7443, lng: -96.8286,
    description: 'Kitchen, two baths, floors. Supplies on site. Roughly 4 hours.',
    slots: ['Sun 10:00 AM'], requirements: ['Cleaning experience'] },
  { posterKey: 'marcus', title: 'Assemble 6 office desks in Plano', category: 'Handyman',
    pay: 200, pay_type: 'flat', location: 'Plano, TX', estimated_hours: 5, urgent: false,
    lat: 33.0198, lng: -96.6989,
    description: 'Flat-pack desks and chairs for a new office. Tools helpful but not required.',
    slots: ['Fri 2:00 PM', 'Mon 9:00 AM'], requirements: ['Own basic tools a plus'] },
  { posterKey: 'marcus', title: 'Same-day errand + grocery drop', category: 'Delivery',
    pay: 40, pay_type: 'flat', location: 'Downtown, Dallas, TX', estimated_hours: 1.5, urgent: true,
    lat: 32.7767, lng: -96.7970,
    description: 'Pick up an order and drop at a downtown office. Must have a car.',
    slots: ['Today 4:00 PM'], requirements: ['Valid license', 'Own vehicle'] },
];

// Bookings reference JOBS by index, USERS by key. status drives lifecycle fields.
const BOOKINGS = [
  { jobIdx: 0, earnerKey: 'priya', slotIdx: 0, status: 'verified',
    application_note: 'Done dozens of apartment moves, have moving straps.',
    review: { rating: 5, text: 'Priya was fast and careful. Would hire again.' },
    messages: [
      { fromKey: 'priya', text: 'Hi! I can be there 8:45 to get started at 9.' },
      { fromKey: 'dana',  text: 'Perfect, unit 304. See you then.' },
    ] },
  { jobIdx: 1, earnerKey: 'priya', slotIdx: 0, status: 'confirmed',
    application_note: 'Available Sunday, I bring my own supplies too.' },
  { jobIdx: 2, earnerKey: 'leo', slotIdx: 0, status: 'completed',
    application_note: 'I assemble flat-pack furniture weekly.',
    messages: [ { fromKey: 'leo', text: 'Wrapped up 5 of 6, finishing the last now.' } ] },
  { jobIdx: 3, earnerKey: 'sam', slotIdx: 0, status: 'pending',
    application_note: 'I can head out right now, 10 min away.' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
async function emailToId() {
  const map = new Map();
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    data.users.forEach(u => u.email && map.set(u.email.toLowerCase(), u.id));
    if (data.users.length < 1000) break;
  }
  return map;
}

async function main() {
  // 1) Allowlist every seed email so handle_new_user won't reject the signup.
  const { error: alErr } = await db.from('beta_allowlist')
    .upsert(USERS.map(u => ({ email: u.email, note: 'seed:dallas' })), { onConflict: 'email' });
  if (alErr) throw alErr;

  // 2) Create (or reuse) auth users, then UPDATE the auto-created profile row.
  const existing = await emailToId();
  const ids = {};
  for (const u of USERS) {
    let id = existing.get(u.email.toLowerCase());
    if (!id) {
      const { data, error } = await db.auth.admin.createUser({
        email: u.email, password: SEED_PASSWORD, email_confirm: true,
        user_metadata: { name: u.name },
      });
      if (error) throw new Error(`createUser ${u.email}: ${error.message}`);
      id = data.user.id;
    }
    ids[u.key] = id;

    const { error: pErr } = await db.from('profiles').update({
      name: u.name, avatar_initial: u.name[0].toUpperCase(), role: u.role, city: u.city,
      bio: u.bio, skills: u.skills, rating: u.rating, review_count: u.review_count,
      poster_rating: u.poster_rating ?? null, poster_review_count: u.poster_review_count ?? 0,
      xp: u.xp, verified: u.verified, onboarding_done: true, date_of_birth: DOB_ADULT,
      radius_miles: 25,
    }).eq('id', id);
    if (pErr) throw new Error(`profile ${u.email}: ${pErr.message}`);
  }

  // 3) Jobs + slots + requirements. Capture slot ids so bookings can reference them.
  const jobIds = [], slotIds = [];
  for (const j of JOBS) {
    const { data: job, error: jErr } = await db.from('jobs').insert({
      title: j.title, category: j.category, pay: j.pay, pay_type: j.pay_type,
      location: j.location, description: j.description, urgent: j.urgent,
      estimated_hours: j.estimated_hours, status: 'open',
      poster_id: ids[j.posterKey], lat: j.lat, lng: j.lng,
    }).select('id').single();
    if (jErr) throw new Error(`job "${j.title}": ${jErr.message}`);
    jobIds.push(job.id);

    const { data: slots, error: sErr } = await db.from('job_slots')
      .insert(j.slots.map(label => ({ job_id: job.id, label, taken: false })))
      .select('id, label');
    if (sErr) throw sErr;
    slotIds.push(slots);

    if (j.requirements?.length) {
      const { error: rErr } = await db.from('job_requirements')
        .insert(j.requirements.map((requirement, i) => ({ job_id: job.id, requirement, sort_order: i })));
      if (rErr) throw rErr;
    }
  }

  // 4) Bookings across the lifecycle (service_role => guard_bookings_write is bypassed).
  for (const b of BOOKINGS) {
    const jobId = jobIds[b.jobIdx];
    const slot  = slotIds[b.jobIdx][b.slotIdx];
    const done  = b.status === 'completed' || b.status === 'verified';
    const { data: booking, error: bErr } = await db.from('bookings').insert({
      job_id: jobId, earner_id: ids[b.earnerKey], slot_id: slot?.id, slot_label: slot?.label,
      status: b.status, application_note: b.application_note,
      earner_done: done, poster_done: done,
      completed_at: done ? new Date().toISOString() : null,
      earner_rating: b.review ? b.review.rating : null,
      review_text: b.review ? b.review.text : null,
    }).select('id').single();
    if (bErr) throw new Error(`booking job#${b.jobIdx}: ${bErr.message}`);

    if (b.status !== 'pending' && slot) {
      await db.from('job_slots').update({ taken: true }).eq('id', slot.id);
    }
    // Booked/verified/completed jobs read better as 'booked'/'completed' on the board.
    await db.from('jobs')
      .update({ status: b.status === 'verified' ? 'completed' : 'booked' })
      .eq('id', jobId);

    if (b.messages) {
      const { error: mErr } = await db.from('messages').insert(
        b.messages.map(m => ({ booking_id: booking.id, sender_id: ids[m.fromKey], text: m.text })));
      if (mErr) throw mErr;
    }

    if (b.review && b.status === 'verified') {
      const poster = JOBS[b.jobIdx].posterKey;
      const { error: revErr } = await db.from('reviews').insert({
        job_id: jobId, reviewer_id: ids[poster], reviewed_user_id: ids[b.earnerKey],
        author: USERS.find(u => u.key === poster).name, rating: b.review.rating,
        text: b.review.text, role: 'earner', date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      });
      if (revErr) throw revErr;
    }
  }

  // 5) Write a manifest so teardown has an exact id list (email domain is the fallback).
  mkdirSync('scripts/.seed', { recursive: true });
  writeFileSync('scripts/.seed/seed-manifest.json', JSON.stringify({
    domain: SEED_DOMAIN,
    users: USERS.map(u => ({ key: u.key, email: u.email, id: ids[u.key] })),
  }, null, 2));

  console.log(`Seeded ${USERS.length} users, ${JOBS.length} jobs, ${BOOKINGS.length} bookings.`);
  console.log('Sign in as any account with password:', SEED_PASSWORD);
}

main().catch(e => { console.error(e); process.exit(1); });
