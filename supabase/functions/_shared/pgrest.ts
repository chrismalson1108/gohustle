// ─────────────────────────────────────────────────────────────────────────────
// PostgREST embedded relations are object-OR-array, and the difference is load-bearing.
//
// `select('*, job:jobs!bookings_job_id_fkey(poster_id)')` returns `job` as an OBJECT
// when PostgREST can prove the relationship is to-one, and as an ARRAY when it cannot.
// Which one you get depends on the foreign keys it finds — that is, on the SCHEMA, not
// on the query. Add a second FK from bookings to jobs and the same select starts
// returning an array.
//
// Five money/authorization paths read it as a bare object:
//
//   if (booking.job.poster_id !== user.id) return 403
//
// If that ever became an array, `.poster_id` is undefined, `undefined !== user.id` is
// true, and EVERY poster is refused: no booking accepted, no payment authorized, no
// capture, no tip. It fails closed, which is the right direction — but it is a total
// outage triggered by an unrelated schema change, with nothing in the code hinting
// that the shape is conditional.
//
// `deno check` was already reporting this (TS2339: Property 'poster_id' does not exist
// on type '{ poster_id: any }[]'), and it was being ignored because the code demonstrably
// works — which it does, today, with today's foreign keys.
//
// one() reads correctly under BOTH shapes, so the behaviour no longer depends on a
// property of the schema that nobody is checking.
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize a PostgREST embedded relation to a single row, or null. */
export function one<T>(v: T | T[] | null | undefined): T | null {
  if (v === null || v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}
