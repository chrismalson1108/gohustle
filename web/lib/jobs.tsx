"use client";

import React, {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useState,
  useCallback,
  useRef,
} from "react";
import { transformJob, transformBooking } from "@gohustlr/shared";
import { supabase } from "./supabaseClient";
import { cacheGet, cacheSet } from "./cache";
import { stripeEdge } from "./edge";
import { notify } from "./push";
import { fetchBlockedIds, blockUserDb } from "./moderation";
import { fetchSavedJobIds, addSavedJob, removeSavedJob } from "./savedJobs";
import { fetchLastMessages, fetchConversationState, isUnread } from "./messages";
import { track, captureError } from "./analytics";
import { useAuth } from "./auth";
import { useUser } from "./user";
import type { Job, Booking } from "./types";

const JOBS_CACHE = "jobs_v1";
const BOOKINGS_CACHE = "bookings_v1";

// Poster/earner sub-selects. "rich" includes the student-verification columns;
// "base" is the pre-migration fallback (see fetchJobs / loadPosterBookings).
const POSTER_RICH = "name, avatar_initial, avatar_url, rating, review_count, verified, school, student_verified, student_status";
const POSTER_BASE = "name, avatar_initial, avatar_url, rating, review_count, verified";
const EARNER_RICH = "id, name, avatar_initial, avatar_url, rating, review_count, school, student_verified, student_status";
const EARNER_BASE = "id, name, avatar_initial, avatar_url, rating, review_count";

interface State {
  jobs: Job[];
  bookings: Booking[];
  posterBookings: Booking[];
  myPostedIds: string[];
}

type Action =
  | { type: "SET_JOBS"; jobs: Job[] }
  | { type: "SET_BOOKINGS"; bookings: Booking[] }
  | { type: "SET_POSTER_BOOKINGS"; bookings: Booking[] }
  | { type: "SET_POSTED_IDS"; ids: string[] }
  | { type: "UPDATE_BOOKING_STATUS"; id: string; patch: Partial<Booking> }
  | { type: "BOOK_JOB"; jobId: string; slotId: string | null; slotLabel: string | null; counterOffer: number | null; tempId: string }
  | { type: "ADD_JOB"; job: Job }
  | { type: "UPDATE_JOB"; jobId: string; patch: Partial<Job> }
  | { type: "DELETE_JOB"; jobId: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "SET_JOBS":
      return { ...state, jobs: action.jobs };
    case "SET_BOOKINGS":
      return { ...state, bookings: action.bookings };
    case "SET_POSTER_BOOKINGS":
      return { ...state, posterBookings: action.bookings };
    case "SET_POSTED_IDS":
      return { ...state, myPostedIds: action.ids };
    case "UPDATE_BOOKING_STATUS": {
      const update = (list: Booking[]) =>
        list.map((b) => (b.id === action.id ? { ...b, ...action.patch } : b));
      return { ...state, bookings: update(state.bookings), posterBookings: update(state.posterBookings) };
    }
    case "BOOK_JOB":
      return {
        ...state,
        jobs: state.jobs.map((j) =>
          j.id !== action.jobId
            ? j
            : { ...j, slots: j.slots.map((s) => (s.id === action.slotId ? { ...s, taken: true } : s)) },
        ),
        bookings: [
          ...state.bookings,
          {
            id: action.tempId,
            jobId: action.jobId,
            slotId: action.slotId,
            slotLabel: action.slotLabel,
            counterOffer: action.counterOffer,
            status: "pending",
          } as Booking,
        ],
      };
    case "ADD_JOB":
      return { ...state, jobs: [action.job, ...state.jobs], myPostedIds: [...state.myPostedIds, action.job.id] };
    case "UPDATE_JOB":
      return { ...state, jobs: state.jobs.map((j) => (j.id === action.jobId ? { ...j, ...action.patch } : j)) };
    case "DELETE_JOB":
      return {
        ...state,
        jobs: state.jobs.filter((j) => j.id !== action.jobId),
        myPostedIds: state.myPostedIds.filter((id) => id !== action.jobId),
      };
    default:
      return state;
  }
}

interface JobsValue extends State {
  blockedIds: Set<string>;
  savedJobIds: Set<string>;
  toggleSavedJob: (jobId: string) => Promise<void>;
  bumpJob: (jobId: string) => Promise<void>;
  unreadMessages: number;
  bookJob: (jobId: string, slotId: string | null, slotLabel?: string | null, counterOffer?: number | null) => Promise<boolean>;
  addJob: (jobData: Record<string, unknown>) => Promise<void>;
  updateJob: (jobId: string, jobData: Record<string, unknown>) => Promise<void>;
  deleteJob: (jobId: string) => Promise<void>;
  isBooked: (jobId: string) => boolean;
  bookedJobs: Job[];
  postedJobs: Job[];
  acceptBooking: (bookingId: string) => Promise<void>;
  declineBooking: (bookingId: string) => Promise<void>;
  cancelBooking: (bookingId: string) => Promise<void>;
  blockUser: (blockedId: string) => Promise<void>;
  refreshUnread: () => Promise<void>;
  markJobComplete: (bookingId: string, completionPhotos?: string[] | null) => Promise<void>;
  markEarnerDone: (bookingId: string, completionPhotos?: string[] | null) => Promise<void>;
  markPosterDone: (bookingId: string) => Promise<void>;
  ratePoster: (bookingId: string, args: { rating: number; reviewText?: string }) => Promise<void>;
  verifyAndRate: (bookingId: string, args: VerifyArgs) => Promise<void>;
  refreshJobs: () => Promise<void>;
  refreshBookings: () => Promise<void>;
  refreshPosterBookings: () => Promise<void>;
  earnBadgeCount: number;
  profileBadgeCount: number;
  proposeAmendment: (bookingId: string, note: string) => Promise<void>;
  respondToAmendment: (bookingId: string, accepted: boolean) => Promise<void>;
  clearAmendment: (bookingId: string) => Promise<void>;
  createPaymentIntent: (bookingId: string) => Promise<{ clientSecret: string; amount: number }>;
  getPayoutOnboardingUrl: () => Promise<{ url: string }>;
  getPayoutStatus: () => Promise<{ hasAccount: boolean; onboarded: boolean }>;
  createSetupIntent: () => Promise<{ clientSecret: string }>;
  getPaymentMethodStatus: () => Promise<{ hasPaymentMethod: boolean }>;
  getPaymentReadiness: () => Promise<{ payoutReady: boolean; paymentMethodReady: boolean }>;
  getPayoutLoginLink: () => Promise<{ url: string }>;
  detachPaymentMethod: () => Promise<unknown>;
}

interface VerifyArgs {
  rating: number;
  reviewText?: string;
  paymentMethod: string;
  pct?: number;
  tipCents?: number;
  disputeReason?: string | null;
}

const JobsContext = createContext<JobsValue | null>(null);

export function JobsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { showToast } = useUser();

  const [state, dispatch] = useReducer(reducer, {
    jobs: [],
    bookings: [],
    posterBookings: [],
    myPostedIds: [],
  });

  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());
  const [savedJobIds, setSavedJobIds] = useState<Set<string>>(new Set());
  const [unreadMessages, setUnreadMessages] = useState(0);

  useEffect(() => {
    if (user) {
      fetchBlockedIds(user.id).then(setBlockedIds).catch(() => {});
      fetchSavedJobIds(user.id).then(setSavedJobIds).catch(() => {});
    } else {
      setBlockedIds(new Set());
      setSavedJobIds(new Set());
    }
  }, [user?.id]);

  const toggleSavedJob = async (jobId: string) => {
    if (!user) return;
    const saving = !savedJobIds.has(jobId);
    setSavedJobIds((prev) => {
      const next = new Set(prev);
      if (saving) next.add(jobId);
      else next.delete(jobId);
      return next;
    });
    try {
      if (saving) await addSavedJob(user.id, jobId);
      else await removeSavedJob(user.id, jobId);
    } catch {
      /* ignore — local state already toggled */
    }
  };

  // Poster bumps a slow gig to the top of the feed (refreshes bumped_at).
  const bumpJob = async (jobId: string) => {
    const now = new Date().toISOString();
    dispatch({ type: "UPDATE_JOB", jobId, patch: { bumpedAt: now } });
    await supabase.from("jobs").update({ bumped_at: now }).eq("id", jobId);
  };

  const blockUser = async (blockedId: string) => {
    if (!user || !blockedId) return;
    await blockUserDb(user.id, blockedId);
    setBlockedIds((prev) => new Set([...prev, blockedId]));
  };

  const refreshUnread = useCallback(async () => {
    if (!user) {
      setUnreadMessages(0);
      return;
    }
    try {
      const ids = [...new Set([...state.bookings.map((b) => b.id), ...state.posterBookings.map((b) => b.id)])];
      if (!ids.length) {
        setUnreadMessages(0);
        return;
      }
      const [last, st] = await Promise.all([fetchLastMessages(ids), fetchConversationState(user.id, ids)]);
      let n = 0;
      ids.forEach((id) => {
        const s = st[id];
        if (!s?.archived && isUnread(last[id], s, user.id)) n++;
      });
      setUnreadMessages(n);
    } catch {
      /* ignore */
    }
  }, [user?.id, state.bookings, state.posterBookings]);

  useEffect(() => {
    refreshUnread();
  }, [refreshUnread]);
  const refreshUnreadRef = useRef(refreshUnread);
  refreshUnreadRef.current = refreshUnread;

  // ── Initial load + realtime ────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    loadFromCacheThenFetch();
    loadBookings();
    loadPosterBookings();
    const cleanup = setupRealtime();
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const loadFromCacheThenFetch = async () => {
    const cached = await cacheGet<Job[]>(JOBS_CACHE);
    if (cached?.length) dispatch({ type: "SET_JOBS", jobs: cached });
    fetchJobs();
  };

  const fetchJobs = useCallback(async () => {
    // Resilient: if the student-verification migration hasn't been run yet, the
    // school/student_* columns don't exist (PostgREST 42703) — fall back to a base
    // poster select so the jobs list never blanks out.
    const jobsSelect = (poster: string) =>
      `*, profiles!jobs_poster_id_fkey(${poster}), job_slots(*), job_requirements(*), reviews(*)`;
    let { data, error } = await supabase
      .from("jobs")
      .select(jobsSelect(POSTER_RICH))
      .neq("status", "cancelled")
      .order("created_at", { ascending: false });
    if (error?.code === "42703") {
      ({ data, error } = await supabase
        .from("jobs")
        .select(jobsSelect(POSTER_BASE))
        .neq("status", "cancelled")
        .order("created_at", { ascending: false }));
    }

    if (error || !data) return;
    const rows = data as unknown as Record<string, unknown>[];
    const transformed = rows.map(transformJob) as Job[];
    dispatch({ type: "SET_JOBS", jobs: transformed });

    if (user) {
      const myIds = rows
        .filter((j) => j.poster_id === user.id && j.status !== "cancelled")
        .map((j) => j.id as string);
      dispatch({ type: "SET_POSTED_IDS", ids: myIds });
    }
    cacheSet(JOBS_CACHE, transformed);
  }, [user?.id]);

  const loadBookings = async () => {
    if (!user) return;
    const cached = await cacheGet<Booking[]>(BOOKINGS_CACHE);
    if (cached?.length) dispatch({ type: "SET_BOOKINGS", bookings: cached });

    const { data, error } = await supabase
      .from("bookings")
      .select(`*, job:jobs!bookings_job_id_fkey(id, title, pay, pay_type)`)
      .eq("earner_id", user.id)
      .order("created_at", { ascending: false });

    if (error || !data) return;
    const bookings = data.map(transformBooking) as Booking[];
    dispatch({ type: "SET_BOOKINGS", bookings });
    cacheSet(BOOKINGS_CACHE, bookings);
  };

  const loadPosterBookings = useCallback(async () => {
    if (!user) return;
    // Exclude cancelled/deleted gigs so a booking on a gig the user removed doesn't
    // keep counting toward the Hiring badge while the gig is hidden from the page.
    const { data: myJobs } = await supabase
      .from("jobs")
      .select("id")
      .eq("poster_id", user.id)
      .neq("status", "cancelled");
    if (!myJobs?.length) {
      // Clear any stale poster bookings (e.g. the user just deleted their last gig).
      dispatch({ type: "SET_POSTER_BOOKINGS", bookings: [] });
      return;
    }
    const jobIds = myJobs.map((j) => j.id);

    const bookingsSelect = (earner: string) =>
      `*, earner:profiles!bookings_earner_id_fkey(${earner}), job:jobs!bookings_job_id_fkey(id, title, pay, pay_type)`;
    let { data, error } = await supabase
      .from("bookings")
      .select(bookingsSelect(EARNER_RICH))
      .in("job_id", jobIds)
      .order("created_at", { ascending: false });
    if (error?.code === "42703") {
      ({ data, error } = await supabase
        .from("bookings")
        .select(bookingsSelect(EARNER_BASE))
        .in("job_id", jobIds)
        .order("created_at", { ascending: false }));
    }

    if (error || !data) return;
    const rows = data as unknown as Record<string, unknown>[];
    dispatch({ type: "SET_POSTER_BOOKINGS", bookings: rows.map(transformBooking) as Booking[] });
  }, [user?.id]);

  const setupRealtime = () => {
    if (!user) return () => {};

    const channel = supabase
      .channel(`bookings-user-${user.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "bookings", filter: `earner_id=eq.${user.id}` },
        (payload) => {
          const b = payload.new as Record<string, unknown>;
          // Patch only scalar fields — the realtime row has no job/earner embed, so
          // running the full transformBooking would wipe the embedded job/earner.
          dispatch({
            type: "UPDATE_BOOKING_STATUS",
            id: b.id as string,
            patch: {
              status: b.status as Booking["status"],
              earnerDone: !!b.earner_done,
              posterDone: !!b.poster_done,
              earnerRating: b.earner_rating != null ? Number(b.earner_rating) : null,
              posterRating: b.poster_rating != null ? Number(b.poster_rating) : null,
              paymentMethod: (b.payment_method as string) ?? null,
              amendmentStatus: (b.amendment_status as Booking["amendmentStatus"]) || "none",
              amendmentNote: (b.amendment_note as string) ?? null,
              tipAmount: b.tip_amount ? Number(b.tip_amount) : 0,
              completionPhotos: (b.completion_photos as string[]) || [],
            },
          });
          if (b.status === "confirmed")
            showToast({ icon: "✅", title: "Booking Confirmed!", message: "The poster accepted your booking. Get ready!" });
          if (b.status === "verified") {
            const stars = `${Math.round((b.earner_rating as number) || 5)}★`;
            showToast({ icon: "💚", title: "Job Verified!", message: `${stars} rating — paid via ${b.payment_method || "cash"}!` });
          }
          if (b.status === "declined")
            showToast({ icon: "😔", title: "Booking Declined", message: "The poster declined this booking." });
        },
      )
      .subscribe();

    const posterChannel = supabase
      .channel(`poster-bookings-${user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, (payload) => {
        loadPosterBookings();
        // Only toast when it's someone ELSE acting on the poster's gig — the broad
        // subscription also delivers the user's own (earner-side) booking rows.
        const isOthers = (payload.new as Record<string, unknown>)?.earner_id !== user.id;
        if (payload.eventType === "INSERT" && isOthers)
          showToast({ icon: "🔔", title: "New Booking Request!", message: "Someone wants to book your gig!" });
        if (isOthers && (payload.new as Record<string, unknown>)?.status === "completed")
          showToast({ icon: "⚡", title: "Job Marked Complete!", message: "An earner says the job is done — verify and rate them!" });
      })
      .subscribe();

    const msgChannel = supabase
      .channel(`messages-unread-${user.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (payload) => {
        if ((payload.new as Record<string, unknown>)?.sender_id === user.id) return;
        refreshUnreadRef.current?.();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(posterChannel);
      supabase.removeChannel(msgChannel);
    };
  };

  // ── Earner actions ───────────────────────────────────────────────────────--
  const bookJob: JobsValue["bookJob"] = async (jobId, slotId, slotLabel = null, counterOffer = null) => {
    if (!user) return false;
    const job = state.jobs.find((j) => j.id === jobId);
    if (job?.posterId === user.id) return false;

    // All bookings start 'pending' and require the poster to Accept (which creates
    // the escrow hold). Instant-book auto-confirm was removed — it skipped escrow,
    // so an instant-booked earner would have worked for free.
    const tempId = `temp-${Date.now()}`;
    dispatch({ type: "BOOK_JOB", jobId, slotId, slotLabel, counterOffer, tempId });

    const chosenSlot = job?.slots?.find((s) => s.id === slotId);
    const { error } = await supabase
      .from("bookings")
      .insert({
        job_id: jobId,
        earner_id: user.id,
        slot_id: slotId || null,
        slot_label: slotLabel || null,
        starts_at: chosenSlot?.startsAt || null,
        counter_offer: counterOffer || null,
        status: "pending",
      })
      .select()
      .single();

    if (error) {
      console.warn("Booking sync error:", error.message);
      // Roll back the optimistic temp booking + slot flip so the UI doesn't show
      // a phantom 'pending' booking on a 'taken' slot.
      if (job) dispatch({ type: "UPDATE_JOB", jobId, patch: { slots: job.slots } });
      await loadBookings();
      return false;
    }
    if (slotId) await supabase.from("job_slots").update({ taken: true }).eq("id", slotId);
    await loadBookings();
    if (job?.posterId)
      notify(job.posterId, "New booking request", `Someone wants to book "${job.title}"`, { tab: "GigsTab" });
    track("booking_created", { jobId, counterOffer: !!counterOffer });
    return true;
  };

  const markEarnerDone: JobsValue["markEarnerDone"] = async (bookingId, completionPhotos = null) => {
    const booking = [...state.bookings, ...state.posterBookings].find((b) => b.id === bookingId);
    const bothDone = booking?.posterDone;
    const patch: Record<string, unknown> = bothDone
      ? { earner_done: true, status: "completed", completed_at: new Date().toISOString() }
      : { earner_done: true };
    if (completionPhotos?.length) patch.completion_photos = completionPhotos;
    const prev = { earnerDone: !!booking?.earnerDone, status: booking?.status, completionPhotos: booking?.completionPhotos };
    dispatch({
      type: "UPDATE_BOOKING_STATUS",
      id: bookingId,
      patch: {
        earnerDone: true,
        ...(completionPhotos?.length && { completionPhotos }),
        ...(bothDone && { status: "completed" as const }),
      },
    });
    const { error } = await supabase.from("bookings").update(patch).eq("id", bookingId);
    if (error) {
      console.warn("Earner done error:", error.message);
      dispatch({ type: "UPDATE_BOOKING_STATUS", id: bookingId, patch: prev }); // roll back
      showToast({ icon: "⚠️", title: "Couldn't mark done", message: "Something went wrong — please try again." });
      return;
    }
    const posterId = state.jobs.find((j) => j.id === booking?.jobId)?.posterId;
    if (posterId) notify(posterId, "Job marked done", "The earner says the job is finished — verify and rate them.", { tab: "GigsTab" });
  };

  const markPosterDone: JobsValue["markPosterDone"] = async (bookingId) => {
    const booking = [...state.bookings, ...state.posterBookings].find((b) => b.id === bookingId);
    const bothDone = booking?.earnerDone;
    const patch: Record<string, unknown> = bothDone
      ? { poster_done: true, status: "completed", completed_at: new Date().toISOString() }
      : { poster_done: true };
    const prev = { posterDone: !!booking?.posterDone, status: booking?.status };
    dispatch({
      type: "UPDATE_BOOKING_STATUS",
      id: bookingId,
      patch: { posterDone: true, ...(bothDone && { status: "completed" as const }) },
    });
    const { error } = await supabase.from("bookings").update(patch).eq("id", bookingId);
    if (error) {
      console.warn("Poster done error:", error.message);
      dispatch({ type: "UPDATE_BOOKING_STATUS", id: bookingId, patch: prev }); // roll back
      showToast({ icon: "⚠️", title: "Couldn't mark done", message: "Something went wrong — please try again." });
      return;
    }
    if (booking?.earner?.id) notify(booking.earner.id, "Poster confirmed completion", "The poster marked the job done on their side.", { tab: "EarnTab" });
  };

  const markJobComplete = markEarnerDone;

  const recomputeRatings = async (userId: string) => {
    // Server-side, tamper-proof: the RPC derives the values from the reviews
    // table (clients can no longer write rating columns directly).
    await supabase.rpc("recompute_user_rating", { target: userId });
  };

  const ratePoster: JobsValue["ratePoster"] = async (bookingId, { rating, reviewText }) => {
    const booking = [...state.bookings, ...state.posterBookings].find((b) => b.id === bookingId);
    const prev = { posterRating: booking?.posterRating, posterReview: booking?.posterReview };
    dispatch({ type: "UPDATE_BOOKING_STATUS", id: bookingId, patch: { posterRating: rating, posterReview: reviewText || null } });
    const { error } = await supabase
      .from("bookings")
      .update({ poster_rating: rating, poster_review: reviewText || null })
      .eq("id", bookingId);
    if (error) {
      console.warn("Rate poster error:", error.message);
      dispatch({ type: "UPDATE_BOOKING_STATUS", id: bookingId, patch: prev }); // roll back
      showToast({ icon: "⚠️", title: "Couldn't submit rating", message: "Something went wrong — please try again." });
      return;
    }
    const { data: jobRow } = await supabase.from("jobs").select("poster_id").eq("id", booking?.jobId).single();
    const posterId = jobRow?.poster_id;
    if (posterId && user) {
      // Guard against a duplicate insert (the unique reviews index rejects re-rating
      // the same booking) so a retry doesn't surface a hard error.
      const { data: existing } = await supabase
        .from("reviews").select("id")
        .eq("job_id", booking!.jobId).eq("reviewer_id", user.id)
        .eq("reviewed_user_id", posterId).eq("role", "poster").maybeSingle();
      if (!existing) {
        const { error: revErr } = await supabase.from("reviews").insert({
          job_id: booking!.jobId,
          reviewer_id: user.id,
          reviewed_user_id: posterId,
          author: "Earner",
          role: "poster",
          rating,
          text: reviewText || "",
          date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        });
        if (revErr) { console.warn("Poster review insert error:", revErr.message); return; }
      }
      await recomputeRatings(posterId);
      notify(posterId, "You were rated", `An earner rated you ${rating}★ as an employer.`, { tab: "GigsTab" });
    }
  };

  // ── Poster actions ───────────────────────────────────────────────────────--
  const acceptBooking: JobsValue["acceptBooking"] = async (bookingId) => {
    const booking = state.posterBookings.find((b) => b.id === bookingId);
    const prevStatus = booking?.status;
    dispatch({ type: "UPDATE_BOOKING_STATUS", id: bookingId, patch: { status: "confirmed" } });
    // Read back the row: the guard trigger silently reverts an illegal transition
    // (e.g. the earner cancelled concurrently) with NO error, so trusting error===null
    // would leave a phantom 'confirmed' with no escrow hold. Reconcile to the truth.
    const { data: row, error } = await supabase
      .from("bookings").update({ status: "confirmed" }).eq("id", bookingId).select("status").single();
    if (error) {
      console.warn("Accept error:", error.message);
      captureError(error, { op: "acceptBooking", bookingId });
      dispatch({ type: "UPDATE_BOOKING_STATUS", id: bookingId, patch: { status: prevStatus } }); // roll back
      showToast({ icon: "⚠️", title: "Couldn't accept booking", message: "Something went wrong — please try again." });
      return;
    }
    if (row && row.status !== "confirmed") {
      dispatch({ type: "UPDATE_BOOKING_STATUS", id: bookingId, patch: { status: row.status as typeof prevStatus } });
      showToast({ icon: "⚠️", title: "Booking changed", message: "This booking was updated elsewhere — refreshed." });
      return;
    }
    if (booking?.earner?.id)
      notify(booking.earner.id, "Booking accepted!", `Your booking for "${booking.job?.title || "a gig"}" was accepted. Get ready!`, { tab: "EarnTab" });
    track("booking_accepted", { bookingId });
  };

  const declineBooking: JobsValue["declineBooking"] = async (bookingId) => {
    try {
      await stripeEdge.cancelPayment(bookingId);
    } catch {
      /* no payment / already cancelled */
    }
    const booking = state.posterBookings.find((b) => b.id === bookingId);
    dispatch({ type: "UPDATE_BOOKING_STATUS", id: bookingId, patch: { status: "declined" } });
    const { error } = await supabase.from("bookings").update({ status: "declined" }).eq("id", bookingId);
    if (error) {
      console.warn("Decline error:", error.message);
      return;
    }
    if (booking?.earner?.id)
      notify(booking.earner.id, "Booking declined", `Your booking for "${booking.job?.title || "a gig"}" wasn't accepted this time.`, { tab: "EarnTab" });
  };

  const cancelBooking: JobsValue["cancelBooking"] = async (bookingId) => {
    const booking = [...state.bookings, ...state.posterBookings].find((b) => b.id === bookingId);
    // Only a pre-settlement booking may be cancelled (the DB guard enforces this too).
    if (booking && !["pending", "confirmed"].includes(booking.status)) {
      showToast({ icon: "⚠️", title: "Can't cancel", message: "This booking can no longer be cancelled." });
      return;
    }
    try {
      await stripeEdge.cancelPayment(bookingId);
    } catch {
      /* no/closed payment */
    }
    dispatch({ type: "UPDATE_BOOKING_STATUS", id: bookingId, patch: { status: "cancelled" } });
    const { error } = await supabase.from("bookings").update({ status: "cancelled" }).eq("id", bookingId);
    if (error) {
      console.warn("Cancel error:", error.message);
      return;
    }
    if (booking?.slotId) await supabase.from("job_slots").update({ taken: false }).eq("id", booking.slotId);

    const posterId = state.jobs.find((j) => j.id === booking?.jobId)?.posterId;
    const title = booking?.job?.title || "a gig";
    const isPoster = posterId && user?.id === posterId;
    if (isPoster && booking?.earner?.id) notify(booking.earner.id, "Booking cancelled", `The poster cancelled "${title}".`, { tab: "EarnTab" });
    else if (posterId) notify(posterId, "Booking cancelled", `The earner cancelled "${title}".`, { tab: "GigsTab" });
  };

  const verifyAndRate: JobsValue["verifyAndRate"] = async (
    bookingId,
    { rating, reviewText, paymentMethod, pct, tipCents, disputeReason },
  ) => {
    const partial = typeof pct === "number" && pct > 0 && pct < 1;

    // Validate state BEFORE moving any money — don't capture escrow or log a dispute
    // for a booking that's missing or already finalized.
    const booking = state.posterBookings.find((b) => b.id === bookingId);
    if (!booking) {
      showToast({ icon: "⚠️", title: "Can't verify", message: "Booking not found — refresh and try again." });
      return;
    }
    if (["verified", "declined", "cancelled"].includes(booking.status)) {
      showToast({ icon: "⚠️", title: "Already finalized", message: "This booking can no longer be verified." });
      return;
    }

    // 'Payment not found' = a pre-Stripe booking with no hold → continue, but remember
    // no money moved so we don't record a meaningless dispute.
    let moneyMoved = true;
    try {
      await stripeEdge.capturePayment(bookingId, partial ? pct : undefined);
    } catch (err) {
      if (!(err as Error).message?.includes("Payment not found")) throw err;
      moneyMoved = false;
    }

    const patch = {
      status: "verified",
      earner_rating: rating,
      review_text: reviewText || null,
      payment_method: paymentMethod,
    };
    dispatch({ type: "UPDATE_BOOKING_STATUS", id: bookingId, patch: { status: "verified", earnerRating: rating, paymentMethod } });

    const { error } = await supabase.from("bookings").update(patch).eq("id", bookingId);
    // The card was already captured above — if persisting the verified status
    // fails we must surface it (not swallow), so the poster knows to retry rather
    // than believing the rating/verification was recorded.
    if (error) throw new Error(error.message);

    if (partial && moneyMoved && user?.id) {
      await supabase.from("disputes").insert({
        booking_id: bookingId,
        raised_by: user.id,
        reason: disputeReason || null,
        pct_paid: Math.round((pct as number) * 100),
      });
    }

    if (booking?.earner?.id) {
      if (partial)
        notify(booking.earner.id, "Job verified with an adjustment", `The poster reported an issue and paid ${Math.round((pct as number) * 100)}%. ${rating}★ rating.`, { tab: "EarnTab" });
      else notify(booking.earner.id, "Job verified — you got paid!", `${rating}★ rating · paid via ${paymentMethod}.`, { tab: "EarnTab" });
    }
    track("job_verified", { rating, paymentMethod, disputed: partial });

    if (tipCents && tipCents >= 50) {
      try {
        await stripeEdge.tip(bookingId, tipCents);
        dispatch({ type: "UPDATE_BOOKING_STATUS", id: bookingId, patch: { tipAmount: tipCents / 100 } });
        if (booking?.earner?.id) notify(booking.earner.id, "You got a tip!", `The poster added a $${(tipCents / 100).toFixed(2)} tip. 🎉`, { tab: "EarnTab" });
        track("tip_sent", { tipCents });
      } catch (e) {
        captureError(e, { op: "tip", bookingId });
        showToast({ icon: "⚠️", title: "Tip not processed", message: "The job was verified, but the tip could not be charged." });
      }
    }

    // Mark the job completed only when no OTHER booking on it is still active
    // (multi-slot gigs can have several earners).
    if (booking?.jobId) {
      const { data: others } = await supabase
        .from("bookings").select("id")
        .eq("job_id", booking.jobId).neq("id", bookingId)
        .in("status", ["pending", "confirmed", "completed"]).limit(1);
      if (!others?.length) {
        dispatch({ type: "UPDATE_JOB", jobId: booking.jobId, patch: { status: "completed" } });
        await supabase.from("jobs").update({ status: "completed" }).eq("id", booking.jobId);
      }
    }

    if (booking?.earner?.id) {
      // Insert once — guard against a double-verify re-inserting the review.
      const { data: existing } = await supabase.from("reviews").select("id")
        .eq("job_id", booking.jobId).eq("reviewer_id", user!.id)
        .eq("reviewed_user_id", booking.earner.id).eq("role", "earner").maybeSingle();
      if (!existing) {
        const { error: revErr } = await supabase.from("reviews").insert({
          job_id: booking.jobId,
          reviewer_id: user!.id,
          reviewed_user_id: booking.earner.id,
          author: "Poster",
          role: "earner",
          rating,
          text: reviewText || "",
          date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        });
        if (revErr) console.warn("Review insert error:", revErr.message);
      }
      await recomputeRatings(booking.earner.id);
    }

    // Earner earnings are credited server-side in stripe-capture-payment (service
    // role, exempt from the profiles write-guard trigger) — single source of truth.
  };

  const updateJob: JobsValue["updateJob"] = async (jobId, jobData) => {
    dispatch({ type: "UPDATE_JOB", jobId, patch: jobData as Partial<Job> });
    const d = jobData as Record<string, unknown>;
    const dbPatch: Record<string, unknown> = {
      title: d.title,
      category: d.category,
      pay: d.pay,
      pay_type: d.payType,
      location: d.location,
      description: d.description,
      urgent: d.urgent,
    };
    if (d.estimatedHours !== undefined) dbPatch.estimated_hours = d.estimatedHours;
    if (d.instantBook !== undefined) dbPatch.instant_book = d.instantBook;
    if (d.instantBookAudience !== undefined) dbPatch.instant_book_audience = d.instantBookAudience;
    if (d.photos !== undefined) dbPatch.photos = d.photos;
    // Privacy: snap public job coords to ~1km (exact location shared post-booking).
    if (d.lat !== undefined) dbPatch.lat = d.lat != null ? Math.round((d.lat as number) * 100) / 100 : null;
    if (d.lng !== undefined) dbPatch.lng = d.lng != null ? Math.round((d.lng as number) * 100) / 100 : null;
    if (d.recurrence !== undefined) dbPatch.recurrence = d.recurrence;
    let { error } = await supabase.from("jobs").update(dbPatch).eq("id", jobId);
    if (error?.code === "42703") {
      // Pre-migration: drop the instant-book columns and retry.
      const { instant_book, instant_book_audience, ...rest } = dbPatch;
      void instant_book;
      void instant_book_audience;
      ({ error } = await supabase.from("jobs").update(rest).eq("id", jobId));
    }
    if (error) {
      console.warn("Update job error:", error.message);
      return;
    }

    const slots = d.slots as Array<{ label: string; taken?: boolean; startsAt?: string | null }> | undefined;
    if (slots) {
      await supabase.from("job_slots").delete().eq("job_id", jobId);
      if (slots.length)
        await supabase
          .from("job_slots")
          .insert(slots.map((s) => ({ job_id: jobId, label: s.label, taken: s.taken || false, starts_at: s.startsAt || null })));
    }
    const reqs = d.requirements as string[] | undefined;
    if (reqs) {
      await supabase.from("job_requirements").delete().eq("job_id", jobId);
      if (reqs.length)
        await supabase.from("job_requirements").insert(reqs.map((r, i) => ({ job_id: jobId, requirement: r, sort_order: i })));
    }
    cacheSet(JOBS_CACHE, null);
  };

  const deleteJob: JobsValue["deleteJob"] = async (jobId) => {
    dispatch({ type: "DELETE_JOB", jobId });
    await supabase.from("jobs").update({ status: "cancelled" }).eq("id", jobId);
    cacheSet(JOBS_CACHE, null);
  };

  const addJob: JobsValue["addJob"] = async (jobData) => {
    if (!user) return;
    const d = jobData as Record<string, unknown>;
    const { data: profile } = await supabase
      .from("profiles")
      .select("name, avatar_initial, avatar_url, rating, review_count, verified, school, student_verified, student_status")
      .eq("id", user.id)
      .single();

    const poster = {
      name: profile?.name || "You",
      avatarInitial: profile?.avatar_initial || "Y",
      avatarUrl: profile?.avatar_url || null,
      rating: Number(profile?.rating) || 5.0,
      reviewCount: profile?.review_count || 0,
      verified: profile?.verified || false,
      school: profile?.school || null,
      studentVerified: profile?.student_verified || false,
      studentStatus: profile?.student_status || "none",
    };

    const baseInsert: Record<string, unknown> = {
      title: d.title,
      category: d.category,
      pay: d.pay,
      pay_type: d.payType,
      location: d.location,
      description: d.description,
      urgent: d.urgent,
      estimated_hours: d.estimatedHours,
      photos: (d.photos as string[]) || [],
      lat: d.lat != null ? Math.round((d.lat as number) * 100) / 100 : null,
      lng: d.lng != null ? Math.round((d.lng as number) * 100) / 100 : null,
      recurrence: (d.recurrence as string) || "none",
      poster_id: user.id,
    };
    // Resilient: include instant_book only if that migration has run (42703 → retry).
    let { data: newJob, error } = await supabase
      .from("jobs")
      .insert({ ...baseInsert, instant_book: !!d.instantBook, instant_book_audience: (d.instantBookAudience as string) || "all" })
      .select()
      .single();
    if (error?.code === "42703") {
      ({ data: newJob, error } = await supabase.from("jobs").insert(baseInsert).select().single());
    }

    if (error || !newJob) {
      console.warn("Job insert error:", error?.message);
      captureError(error || new Error("Job insert failed"), { op: "addJob" });
      return;
    }
    track("gig_posted", { category: d.category, payType: d.payType });

    const slots = d.slots as Array<{ label: string; startsAt?: string | null }> | undefined;
    if (slots?.length)
      await supabase.from("job_slots").insert(slots.map((s) => ({ job_id: newJob.id, label: s.label, taken: false, starts_at: s.startsAt || null })));
    const reqs = d.requirements as string[] | undefined;
    if (reqs?.length)
      await supabase.from("job_requirements").insert(reqs.map((r, i) => ({ job_id: newJob.id, requirement: r, sort_order: i })));

    dispatch({
      type: "ADD_JOB",
      job: {
        ...(jobData as object),
        id: newJob.id,
        posterId: user.id,
        postedAt: "Just now",
        status: "open",
        reviews: [],
        poster,
        slots: slots?.length ? slots : [{ id: "s1", label: "Flexible — Contact to Schedule", taken: false, startsAt: null }],
      } as unknown as Job,
    });
    fetchJobs();
  };

  // ── Amendments ───────────────────────────────────────────────────────────--
  const proposeAmendment: JobsValue["proposeAmendment"] = async (bookingId, note) => {
    const booking = state.posterBookings.find((b) => b.id === bookingId);
    dispatch({ type: "UPDATE_BOOKING_STATUS", id: bookingId, patch: { amendmentNote: note, amendmentStatus: "pending" } });
    await supabase.from("bookings").update({ amendment_note: note, amendment_status: "pending" }).eq("id", bookingId);
    if (booking?.earner?.id) notify(booking.earner.id, "Change proposed", "The poster proposed a change to your gig — review it.", { tab: "EarnTab" });
  };

  const respondToAmendment: JobsValue["respondToAmendment"] = async (bookingId, accepted) => {
    const newStatus = accepted ? "accepted" : "declined";
    const booking = [...state.bookings, ...state.posterBookings].find((b) => b.id === bookingId);
    dispatch({ type: "UPDATE_BOOKING_STATUS", id: bookingId, patch: { amendmentStatus: newStatus } });
    await supabase.from("bookings").update({ amendment_status: newStatus }).eq("id", bookingId);
    const posterId = state.jobs.find((j) => j.id === booking?.jobId)?.posterId;
    if (posterId) notify(posterId, `Change ${newStatus}`, `The earner ${newStatus} your proposed change.`, { tab: "GigsTab" });
  };

  const clearAmendment: JobsValue["clearAmendment"] = async (bookingId) => {
    dispatch({ type: "UPDATE_BOOKING_STATUS", id: bookingId, patch: { amendmentStatus: "none", amendmentNote: null } });
    await supabase.from("bookings").update({ amendment_status: "none", amendment_note: null }).eq("id", bookingId);
  };

  // ── Payment helpers ──────────────────────────────────────────────────────--
  const createPaymentIntent = (bookingId: string) => stripeEdge.createPaymentIntent(bookingId);
  const getPayoutOnboardingUrl = () => stripeEdge.getPayoutOnboardingUrl();
  const getPayoutStatus = async () => {
    if (!user) return { hasAccount: false, onboarded: false };
    const { data } = await supabase.from("stripe_accounts").select("account_id, onboarded").eq("user_id", user.id).single();
    return { hasAccount: !!data, onboarded: data?.onboarded ?? false };
  };
  const createSetupIntent = () => stripeEdge.createSetupIntent();
  const getPayoutLoginLink = () => stripeEdge.getPayoutLoginLink();
  const detachPaymentMethod = () => stripeEdge.detachPaymentMethod();
  const getPaymentMethodStatus = async () => {
    if (!user) return { hasPaymentMethod: false };
    try {
      return await stripeEdge.getPaymentMethodStatus();
    } catch {
      return { hasPaymentMethod: false };
    }
  };
  const getPaymentReadiness = async () => {
    const [payout, pm] = await Promise.all([getPayoutStatus(), getPaymentMethodStatus()]);
    return { payoutReady: payout.onboarded, paymentMethodReady: pm.hasPaymentMethod };
  };

  // ── Derived ──────────────────────────────────────────────────────────────--
  const isBooked = (jobId: string) => state.bookings.some((b) => b.jobId === jobId);
  const bookedJobIds = state.bookings.map((b) => b.jobId);
  const bookedJobs = state.jobs.filter((j) => bookedJobIds.includes(j.id));
  const postedJobs = user ? state.jobs.filter((j) => j.posterId === user.id) : [];
  const earnBadgeCount = state.bookings.filter((b) => b.status === "confirmed" || b.status === "verified").length;
  const profileBadgeCount = state.posterBookings.filter((b) => b.status === "pending" || b.status === "completed").length;

  return (
    <JobsContext.Provider
      value={{
        ...state,
        blockedIds,
        savedJobIds,
        toggleSavedJob,
        bumpJob,
        unreadMessages,
        bookJob,
        addJob,
        updateJob,
        deleteJob,
        isBooked,
        bookedJobs,
        postedJobs,
        acceptBooking,
        declineBooking,
        cancelBooking,
        blockUser,
        refreshUnread,
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
      }}
    >
      {children}
    </JobsContext.Provider>
  );
}

export const useJobs = (): JobsValue => {
  const ctx = useContext(JobsContext);
  if (!ctx) throw new Error("useJobs must be used within JobsProvider");
  return ctx;
};
