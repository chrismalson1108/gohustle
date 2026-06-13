import React, { createContext, useContext, useReducer, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { cacheGet, cacheSet } from '../lib/cache';
import { stripeEdge } from '../lib/stripeClient';
import { useAuth } from './AuthContext';
import { useUser } from './UserContext';

const JobsContext = createContext(null);

const JOBS_CACHE     = 'jobs_v1';
const BOOKINGS_CACHE = 'bookings_v1';

// ─── Transformers ────────────────────────────────────────────────────────────

function transformJob(dbJob) {
  return {
    id: dbJob.id,
    posterId: dbJob.poster_id,
    title: dbJob.title,
    category: dbJob.category,
    pay: Number(dbJob.pay),
    payType: dbJob.pay_type,
    location: dbJob.location,
    description: dbJob.description,
    urgent: dbJob.urgent,
    estimatedHours: Number(dbJob.estimated_hours),
    status: dbJob.status,
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
    },
    slots: (dbJob.job_slots || []).map(s => ({ id: s.id, label: s.label, taken: s.taken })),
    requirements: (dbJob.job_requirements || [])
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(r => r.requirement),
    reviews: (dbJob.reviews || []).map(r => ({
      id: r.id, author: r.author, rating: Number(r.rating), text: r.text, date: r.date,
    })),
  };
}

function transformBooking(b) {
  return {
    id: b.id,
    jobId: b.job_id,
    slotId: b.slot_id,
    slotLabel: b.slot_label,
    counterOffer: b.counter_offer ? Number(b.counter_offer) : null,
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
    completionPhotos: b.completion_photos || [],
    earner: b.earner ? {
      id: b.earner.id,
      name: b.earner.name,
      avatarInitial: b.earner.avatar_initial,
      avatarUrl: b.earner.avatar_url || null,
      rating: Number(b.earner.rating),
      reviewCount: b.earner.review_count,
    } : null,
    job: b.job ? {
      id: b.job.id,
      title: b.job.title,
      pay: Number(b.job.pay),
      payType: b.job.pay_type,
    } : null,
  };
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

function reducer(state, action) {
  switch (action.type) {
    case 'SET_JOBS':
      return { ...state, jobs: action.jobs };

    case 'SET_BOOKINGS':
      return { ...state, bookings: action.bookings };

    case 'SET_POSTER_BOOKINGS':
      return { ...state, posterBookings: action.bookings };

    case 'SET_POSTED_IDS':
      return { ...state, myPostedIds: action.ids };

    case 'UPDATE_BOOKING_STATUS': {
      const updateList = list =>
        list.map(b => b.id === action.id ? { ...b, ...action.patch } : b);
      return {
        ...state,
        bookings:       updateList(state.bookings),
        posterBookings: updateList(state.posterBookings),
      };
    }

    case 'BOOK_JOB':
      return {
        ...state,
        jobs: state.jobs.map(j => {
          if (j.id !== action.jobId) return j;
          return {
            ...j,
            slots: j.slots.map(s => s.id === action.slotId ? { ...s, taken: true } : s),
          };
        }),
        bookings: [...state.bookings, {
          id: action.tempId,
          jobId: action.jobId,
          slotId: action.slotId,
          slotLabel: action.slotLabel || null,
          counterOffer: action.counterOffer || null,
          status: 'pending',
        }],
      };

    case 'ADD_JOB':
      return {
        ...state,
        jobs: [{ ...action.job, poster: action.poster }, ...state.jobs],
        myPostedIds: [...state.myPostedIds, action.job.id],
      };

    case 'UPDATE_JOB':
      return {
        ...state,
        jobs: state.jobs.map(j => j.id === action.jobId ? { ...j, ...action.patch } : j),
      };

    case 'DELETE_JOB':
      return {
        ...state,
        jobs: state.jobs.filter(j => j.id !== action.jobId),
        myPostedIds: state.myPostedIds.filter(id => id !== action.jobId),
      };

    default:
      return state;
  }
}

// ─── Provider ────────────────────────────────────────────────────────────────

export function JobsProvider({ children }) {
  const { user } = useAuth();
  const { showToast } = useUser();

  const [state, dispatch] = useReducer(reducer, {
    jobs: [],
    bookings: [],
    posterBookings: [],
    myPostedIds: [],
  });

  const myPostedIdsRef = useRef([]);
  myPostedIdsRef.current = state.myPostedIds;

  // ── Initial data load ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    loadFromCacheThenFetch();
    loadBookings();
    loadPosterBookings();
    const cleanup = setupRealtime();
    return cleanup;
  }, [user?.id]);

  const loadFromCacheThenFetch = async () => {
    const cached = await cacheGet(JOBS_CACHE);
    if (cached?.length) dispatch({ type: 'SET_JOBS', jobs: cached });
    fetchJobs();
  };

  const fetchJobs = useCallback(async () => {
    const { data, error } = await supabase
      .from('jobs')
      .select(`
        *,
        profiles!jobs_poster_id_fkey(name, avatar_initial, avatar_url, rating, review_count, verified),
        job_slots(*),
        job_requirements(*),
        reviews(*)
      `)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: false });

    if (error || !data) return;
    const transformed = data.map(transformJob);
    dispatch({ type: 'SET_JOBS', jobs: transformed });

    // Populate myPostedIds from DB
    if (user) {
      const myIds = data.filter(j => j.poster_id === user.id && j.status !== 'cancelled').map(j => j.id);
      dispatch({ type: 'SET_POSTED_IDS', ids: myIds });
    }

    cacheSet(JOBS_CACHE, transformed);
  }, [user?.id]);

  const loadBookings = async () => {
    if (!user) return;
    const cached = await cacheGet(BOOKINGS_CACHE);
    if (cached?.length) dispatch({ type: 'SET_BOOKINGS', bookings: cached });

    const { data, error } = await supabase
      .from('bookings')
      .select(`
        *,
        job:jobs!bookings_job_id_fkey(id, title, pay, pay_type)
      `)
      .eq('earner_id', user.id)
      .order('created_at', { ascending: false });

    if (error || !data) return;
    const bookings = data.map(transformBooking);
    dispatch({ type: 'SET_BOOKINGS', bookings });
    cacheSet(BOOKINGS_CACHE, bookings);
  };

  const loadPosterBookings = useCallback(async () => {
    if (!user) return;
    // Get IDs of jobs posted by this user
    const { data: myJobs } = await supabase
      .from('jobs')
      .select('id')
      .eq('poster_id', user.id);

    if (!myJobs?.length) return;
    const jobIds = myJobs.map(j => j.id);

    const { data, error } = await supabase
      .from('bookings')
      .select(`
        *,
        earner:profiles!bookings_earner_id_fkey(id, name, avatar_initial, avatar_url, rating, review_count),
        job:jobs!bookings_job_id_fkey(id, title, pay, pay_type)
      `)
      .in('job_id', jobIds)
      .order('created_at', { ascending: false });

    if (error || !data) return;
    dispatch({ type: 'SET_POSTER_BOOKINGS', bookings: data.map(transformBooking) });
  }, [user?.id]);

  // ── Realtime subscriptions ─────────────────────────────────────────────────
  const setupRealtime = () => {
    if (!user) return () => {};

    const channel = supabase.channel(`bookings-user-${user.id}`)
      // Earner: watch for status changes on my bookings
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'bookings',
        filter: `earner_id=eq.${user.id}`,
      }, (payload) => {
        const b = payload.new;
        dispatch({ type: 'UPDATE_BOOKING_STATUS', id: b.id, patch: transformBooking(b) });
        if (b.status === 'confirmed') {
          showToast({ icon: '✅', title: 'Booking Confirmed!', message: 'The poster accepted your booking. Get ready!' });
        }
        if (b.status === 'verified') {
          const stars = `${Math.round(b.earner_rating || 5)}★`;
          showToast({ icon: '💚', title: 'Job Verified!', message: `${stars} rating — paid via ${b.payment_method || 'cash'}!` });
        }
        if (b.status === 'declined') {
          showToast({ icon: '😔', title: 'Booking Declined', message: 'The poster declined this booking.' });
        }
      })
      .subscribe();

    // Poster: watch for updates to bookings on my jobs (new bookings + earner completions)
    const posterChannel = supabase.channel(`poster-bookings-${user.id}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'bookings',
      }, (payload) => {
        // Refresh poster bookings on any change — simple and reliable
        loadPosterBookings();
        if (payload.eventType === 'INSERT') {
          showToast({ icon: '🔔', title: 'New Booking Request!', message: 'Someone wants to book your gig!' });
        }
        if (payload.new?.status === 'completed') {
          showToast({ icon: '⚡', title: 'Job Marked Complete!', message: 'An earner says the job is done — verify and rate them!' });
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(posterChannel);
    };
  };

  // ── Earner actions ─────────────────────────────────────────────────────────

  const bookJob = async (jobId, slotId, slotLabel, counterOffer) => {
    if (!user) return;
    const job = state.jobs.find(j => j.id === jobId);
    if (job?.posterId === user.id) return; // can't book own gig

    const tempId = `temp-${Date.now()}`;
    dispatch({ type: 'BOOK_JOB', jobId, slotId, slotLabel, counterOffer, tempId });

    const { data, error } = await supabase.from('bookings').insert({
      job_id: jobId,
      earner_id: user.id,
      slot_id: slotId || null,
      slot_label: slotLabel || null,
      counter_offer: counterOffer || null,
      status: 'pending',
    }).select().single();

    if (error) { console.warn('Booking sync error:', error.message); return; }

    if (slotId) {
      supabase.from('job_slots').update({ taken: true }).eq('id', slotId);
    }

    // Replace temp booking with real one
    await loadBookings();
  };

  // Earner marks their side done; if poster already done → complete.
  // Optional completionPhotos (array of public URLs) are saved as proof of work.
  const markEarnerDone = async (bookingId, completionPhotos = null) => {
    const booking = [...state.bookings, ...state.posterBookings].find(b => b.id === bookingId);
    const bothDone = booking?.posterDone;
    const patch = bothDone
      ? { earner_done: true, status: 'completed', completed_at: new Date().toISOString() }
      : { earner_done: true };
    if (completionPhotos?.length) patch.completion_photos = completionPhotos;
    dispatch({ type: 'UPDATE_BOOKING_STATUS', id: bookingId, patch: {
      earnerDone: true,
      ...(completionPhotos?.length && { completionPhotos }),
      ...(bothDone && { status: 'completed' }),
    } });
    const { error } = await supabase.from('bookings').update(patch).eq('id', bookingId);
    if (error) console.warn('Earner done error:', error.message);
  };

  // Poster marks their side done; if earner already done → complete
  const markPosterDone = async (bookingId) => {
    const booking = [...state.bookings, ...state.posterBookings].find(b => b.id === bookingId);
    const bothDone = booking?.earnerDone;
    const patch = bothDone
      ? { poster_done: true, status: 'completed', completed_at: new Date().toISOString() }
      : { poster_done: true };
    dispatch({ type: 'UPDATE_BOOKING_STATUS', id: bookingId, patch: { posterDone: true, ...(bothDone && { status: 'completed' }) } });
    const { error } = await supabase.from('bookings').update(patch).eq('id', bookingId);
    if (error) console.warn('Poster done error:', error.message);
  };

  // Keep old name as alias for earner side
  const markJobComplete = markEarnerDone;

  // Earner rates the poster after job is verified
  const ratePoster = async (bookingId, { rating, reviewText }) => {
    const booking = [...state.bookings, ...state.posterBookings].find(b => b.id === bookingId);
    dispatch({ type: 'UPDATE_BOOKING_STATUS', id: bookingId, patch: { posterRating: rating, posterReview: reviewText } });
    const { error } = await supabase.from('bookings').update({
      poster_rating: rating,
      poster_review: reviewText || null,
    }).eq('id', bookingId);
    if (error) { console.warn('Rate poster error:', error.message); return; }

    // Update poster's rolling rating on their profile
    if (booking?.jobId) {
      const { data: jobRow } = await supabase.from('jobs').select('poster_id').eq('id', booking.jobId).single();
      if (jobRow?.poster_id) {
        const { data: posterProfile } = await supabase
          .from('profiles')
          .select('poster_rating, poster_review_count')
          .eq('id', jobRow.poster_id)
          .single();
        if (posterProfile) {
          const oldCount  = posterProfile.poster_review_count || 0;
          const newCount  = oldCount + 1;
          const newRating = (((posterProfile.poster_rating || 5) * oldCount) + rating) / newCount;
          await supabase.from('profiles').update({
            poster_rating: parseFloat(newRating.toFixed(1)),
            poster_review_count: newCount,
          }).eq('id', jobRow.poster_id);
        }
      }
    }
  };

  // ── Poster actions ─────────────────────────────────────────────────────────

  const acceptBooking = async (bookingId) => {
    dispatch({ type: 'UPDATE_BOOKING_STATUS', id: bookingId, patch: { status: 'confirmed' } });
    const { error } = await supabase
      .from('bookings')
      .update({ status: 'confirmed' })
      .eq('id', bookingId);
    if (error) console.warn('Accept error:', error.message);
  };

  const declineBooking = async (bookingId) => {
    // Cancel any held payment before declining (releases card hold, no charge)
    try {
      await stripeEdge.cancelPayment(bookingId);
    } catch (_) {
      // No payment or already cancelled — safe to ignore
    }
    dispatch({ type: 'UPDATE_BOOKING_STATUS', id: bookingId, patch: { status: 'declined' } });
    const { error } = await supabase
      .from('bookings')
      .update({ status: 'declined' })
      .eq('id', bookingId);
    if (error) console.warn('Decline error:', error.message);
  };

  const verifyAndRate = async (bookingId, { rating, reviewText, paymentMethod }) => {
    // Capture escrow payment first — if this fails, abort (don't mark verified)
    try {
      await stripeEdge.capturePayment(bookingId);
    } catch (err) {
      if (!err.message?.includes('Payment not found')) {
        throw err;
      }
      // Booking has no payment record (pre-Stripe) — continue without capture
    }

    const booking = state.posterBookings.find(b => b.id === bookingId);
    const patch = {
      status: 'verified',
      earner_rating: rating,
      review_text: reviewText || null,
      payment_method: paymentMethod,
    };
    dispatch({ type: 'UPDATE_BOOKING_STATUS', id: bookingId, patch: { ...patch, earnerRating: rating, paymentMethod } });

    const { error } = await supabase.from('bookings').update(patch).eq('id', bookingId);
    if (error) { console.warn('Verify error:', error.message); return; }

    // Mark the job itself as completed so it leaves the Browse screen
    if (booking?.jobId) {
      dispatch({ type: 'UPDATE_JOB', jobId: booking.jobId, patch: { status: 'completed' } });
      supabase.from('jobs').update({ status: 'completed' }).eq('id', booking.jobId);
    }

    // Insert review — always insert (even without text) so review_count stays accurate
    if (booking?.earner?.id) {
      const { error: revErr } = await supabase.from('reviews').insert({
        job_id: booking.jobId,
        reviewer_id: user.id,
        reviewed_user_id: booking.earner.id,
        author: booking.earner.name || 'Poster',
        rating,
        text: reviewText || '',
        date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      });
      if (revErr) console.warn('Review insert error:', revErr.message);
    }

    // Update earner's rolling rating
    if (booking?.earner?.id) {
      const { data: earnerProfile } = await supabase
        .from('profiles')
        .select('rating, review_count')
        .eq('id', booking.earner.id)
        .single();

      if (earnerProfile) {
        const newCount  = (earnerProfile.review_count || 0) + 1;
        const newRating = (((earnerProfile.rating || 5) * (earnerProfile.review_count || 0)) + rating) / newCount;
        await supabase.from('profiles').update({
          rating: parseFloat(newRating.toFixed(1)),
          review_count: newCount,
        }).eq('id', booking.earner.id);
      }
    }

    // Credit the earner's earnings with their captured payout (amount after the 10% fee)
    if (booking?.earner?.id) {
      const { data: payment } = await supabase
        .from('payments')
        .select('earner_amount_cents')
        .eq('booking_id', bookingId)
        .single();

      if (payment?.earner_amount_cents) {
        const dollars = payment.earner_amount_cents / 100;
        const { data: ep } = await supabase
          .from('profiles')
          .select('earnings_today, earnings_week, earnings_total')
          .eq('id', booking.earner.id)
          .single();
        if (ep) {
          await supabase.from('profiles').update({
            earnings_today: Number(ep.earnings_today || 0) + dollars,
            earnings_week:  Number(ep.earnings_week  || 0) + dollars,
            earnings_total: Number(ep.earnings_total || 0) + dollars,
          }).eq('id', booking.earner.id);
        }
      }
    }
  };

  const updateJob = async (jobId, jobData) => {
    dispatch({ type: 'UPDATE_JOB', jobId, patch: jobData });
    const dbPatch = {
      title: jobData.title, category: jobData.category,
      pay: jobData.pay, pay_type: jobData.payType,
      location: jobData.location, description: jobData.description,
      urgent: jobData.urgent,
    };
    const { error } = await supabase.from('jobs').update(dbPatch).eq('id', jobId);
    if (error) { console.warn('Update job error:', error.message); return; }

    if (jobData.slots) {
      await supabase.from('job_slots').delete().eq('job_id', jobId);
      if (jobData.slots.length) {
        await supabase.from('job_slots').insert(
          jobData.slots.map(s => ({ job_id: jobId, label: s.label, taken: s.taken || false }))
        );
      }
    }
    if (jobData.requirements) {
      await supabase.from('job_requirements').delete().eq('job_id', jobId);
      if (jobData.requirements.length) {
        await supabase.from('job_requirements').insert(
          jobData.requirements.map((r, i) => ({ job_id: jobId, requirement: r, sort_order: i }))
        );
      }
    }
    cacheSet(JOBS_CACHE, null);
  };

  const deleteJob = async (jobId) => {
    dispatch({ type: 'DELETE_JOB', jobId });
    await supabase.from('jobs').update({ status: 'cancelled' }).eq('id', jobId);
    cacheSet(JOBS_CACHE, null);
  };

  const addJob = async (jobData) => {
    if (!user) return;
    const { data: profile } = await supabase
      .from('profiles')
      .select('name, avatar_initial, avatar_url, rating, review_count, verified')
      .eq('id', user.id)
      .single();

    const poster = {
      name: profile?.name || 'You',
      avatarInitial: profile?.avatar_initial || 'Y',
      avatarUrl: profile?.avatar_url || null,
      rating: Number(profile?.rating) || 5.0,
      reviewCount: profile?.review_count || 0,
      verified: profile?.verified || false,
    };

    const { data: newJob, error } = await supabase
      .from('jobs')
      .insert({
        title: jobData.title, category: jobData.category,
        pay: jobData.pay, pay_type: jobData.payType,
        location: jobData.location, description: jobData.description,
        urgent: jobData.urgent, estimated_hours: jobData.estimatedHours,
        poster_id: user.id,
      })
      .select().single();

    if (error || !newJob) { console.warn('Job insert error:', error?.message); return; }

    if (jobData.slots?.length) {
      await supabase.from('job_slots').insert(
        jobData.slots.map(s => ({ job_id: newJob.id, label: s.label, taken: false }))
      );
    }
    if (jobData.requirements?.length) {
      await supabase.from('job_requirements').insert(
        jobData.requirements.map((r, i) => ({ job_id: newJob.id, requirement: r, sort_order: i }))
      );
    }

    dispatch({
      type: 'ADD_JOB',
      job: {
        ...jobData,
        id: newJob.id,
        posterId: user.id,
        postedAt: 'Just now',
        status: 'open',
        reviews: [],
        slots: jobData.slots?.length
          ? jobData.slots
          : [{ id: 's1', label: 'Flexible — Contact to Schedule', taken: false }],
      },
      poster,
    });
    // Re-fetch in background to replace optimistic slots with real DB IDs
    fetchJobs();
  };

  // ── Derived state ──────────────────────────────────────────────────────────
  const isBooked       = (jobId) => state.bookings.some(b => b.jobId === jobId);
  const bookedJobIds   = state.bookings.map(b => b.jobId);
  const bookedJobs     = state.jobs.filter(j => bookedJobIds.includes(j.id));
  // Derive directly from posterId so it works immediately on cache warm-up and after addJob
  const postedJobs     = user ? state.jobs.filter(j => j.posterId === user.id) : [];

  // Badge counts for tab bar
  const earnBadgeCount    = state.bookings.filter(b => b.status === 'confirmed' || b.status === 'verified').length;
  const profileBadgeCount = state.posterBookings.filter(b => b.status === 'pending' || b.status === 'completed').length;

  // ── Payment helpers (thin wrappers so screens don't import stripeEdge directly) ──

  const createPaymentIntent = (bookingId) => stripeEdge.createPaymentIntent(bookingId);

  const getPayoutOnboardingUrl = () => stripeEdge.getPayoutOnboardingUrl();

  const getPayoutStatus = async () => {
    if (!user) return { hasAccount: false, onboarded: false };
    const { data } = await supabase
      .from('stripe_accounts')
      .select('account_id, onboarded')
      .eq('user_id', user.id)
      .single();
    return { hasAccount: !!data, onboarded: data?.onboarded ?? false };
  };

  // Poster side: do they have a saved card on file?
  const createSetupIntent = () => stripeEdge.createSetupIntent();

  // Earner side: manage payout/bank details in the Stripe Express dashboard
  const getPayoutLoginLink = () => stripeEdge.getPayoutLoginLink();

  // Poster side: remove all saved cards
  const detachPaymentMethod = () => stripeEdge.detachPaymentMethod();

  const getPaymentMethodStatus = async () => {
    if (!user) return { hasPaymentMethod: false };
    try {
      return await stripeEdge.getPaymentMethodStatus();
    } catch (_) {
      return { hasPaymentMethod: false };
    }
  };

  // Unified readiness for both roles — drives the payment-setup alerts.
  const getPaymentReadiness = async () => {
    const [payout, pm] = await Promise.all([
      getPayoutStatus(),
      getPaymentMethodStatus(),
    ]);
    return {
      payoutReady: payout.onboarded,
      paymentMethodReady: pm.hasPaymentMethod,
    };
  };

  // ── Amendments ─────────────────────────────────────────────────────────────

  const proposeAmendment = async (bookingId, note) => {
    dispatch({ type: 'UPDATE_BOOKING_STATUS', id: bookingId, patch: { amendmentNote: note, amendmentStatus: 'pending' } });
    await supabase.from('bookings').update({ amendment_note: note, amendment_status: 'pending' }).eq('id', bookingId);
  };

  const respondToAmendment = async (bookingId, accepted) => {
    const newStatus = accepted ? 'accepted' : 'declined';
    dispatch({ type: 'UPDATE_BOOKING_STATUS', id: bookingId, patch: { amendmentStatus: newStatus } });
    await supabase.from('bookings').update({ amendment_status: newStatus }).eq('id', bookingId);
  };

  const clearAmendment = async (bookingId) => {
    dispatch({ type: 'UPDATE_BOOKING_STATUS', id: bookingId, patch: { amendmentStatus: 'none', amendmentNote: null } });
    await supabase.from('bookings').update({ amendment_status: 'none', amendment_note: null }).eq('id', bookingId);
  };

  return (
    <JobsContext.Provider value={{
      ...state,
      bookJob,
      addJob,
      updateJob,
      deleteJob,
      isBooked,
      bookedJobs,
      postedJobs,
      acceptBooking,
      declineBooking,
      markJobComplete,
      markEarnerDone,
      markPosterDone,
      ratePoster,
      verifyAndRate,
      refreshJobs: fetchJobs,
      refreshBookings: loadBookings,
      refreshPosterBookings: loadPosterBookings,
      earnBadgeCount,
      profileBadgeCount,
      proposeAmendment,
      respondToAmendment,
      clearAmendment,
      createPaymentIntent,
      getPayoutOnboardingUrl,
      getPayoutStatus,
      createSetupIntent,
      getPaymentMethodStatus,
      getPaymentReadiness,
      getPayoutLoginLink,
      detachPaymentMethod,
    }}>
      {children}
    </JobsContext.Provider>
  );
}

export const useJobs = () => useContext(JobsContext);
