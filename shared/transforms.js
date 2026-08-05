// Map raw Supabase rows → the client-facing shapes used across the UI.
// Mirrors transformJob / transformBooking in src/context/JobsContext.js so the
// website and mobile app interpret the same backend identically.
import { resolveCategorySlug } from './categories.js';

// `category` is the DISPLAY label and `categorySlug` is the IDENTITY everything
// filters, groups and counts on. The slug is derived here when the row doesn't
// carry it, so a query that hasn't yet added `category_slug` to its select list
// still produces a job every consumer can match on.
const slugOf = (row) => row?.category_slug || resolveCategorySlug(row?.category);

export function transformJob(dbJob) {
  return {
    id: dbJob.id,
    posterId: dbJob.poster_id,
    title: dbJob.title,
    category: dbJob.category,
    categorySlug: slugOf(dbJob),
    pay: Number(dbJob.pay),
    payType: dbJob.pay_type,
    location: dbJob.location,
    description: dbJob.description,
    urgent: dbJob.urgent,
    estimatedHours: Number(dbJob.estimated_hours),
    status: dbJob.status,
    photos: dbJob.photos || [],
    recurrence: dbJob.recurrence || 'none',
    tags: dbJob.tags || [],
    hazards: dbJob.hazards || [],
    instantBook: dbJob.instant_book || false,
    instantBookAudience: dbJob.instant_book_audience || 'all',
    bumpedAt: dbJob.bumped_at || null,
    createdAt: dbJob.created_at || null,
    lat: dbJob.lat ?? null,
    lng: dbJob.lng ?? null,
    postedAt: dbJob.created_at
      ? new Date(dbJob.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : 'Recently',
    poster: {
      name: dbJob.profiles?.name || 'Anonymous',
      avatarInitial: dbJob.profiles?.avatar_initial || 'A',
      avatarUrl: dbJob.profiles?.avatar_url || null,
      rating: Number(dbJob.profiles?.rating) || 5.0,
      reviewCount: dbJob.profiles?.review_count || 0,
      verified: dbJob.profiles?.verified || false,
      school: dbJob.profiles?.school || null,
      studentVerified: dbJob.profiles?.student_verified || false,
      studentStatus: dbJob.profiles?.student_status || 'none',
    },
    slots: (dbJob.job_slots || []).map(s => ({ id: s.id, label: s.label, taken: s.taken, startsAt: s.starts_at || null })),
    requirements: (dbJob.job_requirements || [])
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(r => r.requirement),
    reviews: (dbJob.reviews || []).map(r => ({
      id: r.id, author: r.author, rating: Number(r.rating), text: r.text, date: r.date,
    })),
  };
}

// A booking can reference a job that isn't in the browse feed — the poster
// soft-cancelled it, or it simply fell outside the capped/most-recent window.
// Synthesize a JobCard-safe job from the thin embed on the booking so the earner
// never loses sight of work they committed to. Every field JobCard touches must
// be present here (notably `poster`, which it dereferences unguarded).
export function fallbackJobFromBooking(b) {
  if (!b?.jobId) return null;
  const j = b.job || {};
  return {
    id: b.jobId,
    posterId: j.posterId ?? null,
    title: j.title || 'Gig no longer listed',
    // No category rather than a guessed one. This used to default to 'Odd Jobs' —
    // a real, filterable category — so a booking with a thin embed invented work
    // history in a category the gig was never posted under, and that phantom fed
    // the Jack of All Trades count and the Hustlr Certified tally.
    category: j.category || '',
    categorySlug: j.categorySlug || resolveCategorySlug(j.category),
    pay: Number(j.pay) || 0,
    payType: j.payType || 'flat',
    location: j.location || '',
    description: '',
    urgent: false,
    estimatedHours: 1,
    status: 'cancelled',
    photos: [],
    recurrence: 'none',
    tags: [],
    hazards: [],
    instantBook: false,
    instantBookAudience: 'all',
    bumpedAt: null,
    createdAt: j.createdAt || null,
    lat: null,
    lng: null,
    postedAt: j.createdAt
      ? new Date(j.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : 'Recently',
    poster: {
      name: 'Poster',
      avatarInitial: 'P',
      avatarUrl: null,
      rating: 5.0,
      reviewCount: 0,
      verified: false,
      school: null,
      studentVerified: false,
      studentStatus: 'none',
    },
    slots: [],
    requirements: [],
    reviews: [],
  };
}

export function transformBooking(b) {
  return {
    id: b.id,
    jobId: b.job_id,
    createdAt: b.created_at || null,
    slotId: b.slot_id,
    slotLabel: b.slot_label,
    counterOffer: b.counter_offer ? Number(b.counter_offer) : null,
    applicationNote: b.application_note || null,
    status: b.status || 'pending',
    paymentMethod: b.payment_method,
    earnerRating: b.earner_rating ? Number(b.earner_rating) : null,
    reviewText: b.review_text,
    completedAt: b.completed_at,
    earnerDone: b.earner_done || false,
    posterDone: b.poster_done || false,
    posterRating: b.poster_rating ? Number(b.poster_rating) : null,
    posterReview: b.poster_review || null,
    amendmentNote: b.amendment_note || null,
    amendmentStatus: b.amendment_status || 'none',
    beforePhotos: b.before_photos || [],
    completionPhotos: b.completion_photos || [],
    startsAt: b.starts_at || null,
    startedAt: b.started_at || null,
    cancellationFee: b.cancellation_fee != null ? Number(b.cancellation_fee) : null,
    tipAmount: b.tip_amount ? Number(b.tip_amount) : 0,
    earner: b.earner ? {
      id: b.earner.id,
      name: b.earner.name,
      avatarInitial: b.earner.avatar_initial,
      avatarUrl: b.earner.avatar_url || null,
      rating: Number(b.earner.rating),
      reviewCount: b.earner.review_count,
      skills: b.earner.skills || [],
      school: b.earner.school || null,
      studentVerified: b.earner.student_verified || false,
      studentStatus: b.earner.student_status || 'none',
    } : null,
    job: b.job ? {
      id: b.job.id,
      title: b.job.title,
      pay: Number(b.job.pay),
      payType: b.job.pay_type,
      location: b.job.location || null,
      // Needed by the badge engine (category variety, repeat-client and
      // apply-speed rules). Nullable — older joins may not select them.
      category: b.job.category || null,
      categorySlug: slugOf(b.job) || null,
      posterId: b.job.poster_id || null,
      createdAt: b.job.created_at || null,
    } : null,
  };
}
