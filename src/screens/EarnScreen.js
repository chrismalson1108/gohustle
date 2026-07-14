import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Image,
  Modal, TextInput, KeyboardAvoidingView, Platform, ActivityIndicator,
  RefreshControl, Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import GradientHeader from '../components/GradientHeader';
import ChallengeCard from '../components/ChallengeCard';
import JobCard from '../components/JobCard';
import XPBar from '../components/XPBar';
import MoneyGoalCard from '../components/MoneyGoalCard';
import WorkStatusBar from '../components/WorkStatusBar';
import BookingStatusBadge from '../components/BookingStatusBadge';
import MessageSheet from '../components/MessageSheet';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import { useAuth } from '../context/AuthContext';
import { useHaptic } from '../hooks/useHaptic';
import { pickImages, uploadPrivateImages } from '../lib/uploadImage';
import SignedImage from '../components/SignedImage';
import { computeEarnerInsights } from '../lib/insights';
import { addExpense } from '../lib/expenses';
import { haversineMiles } from '../lib/geo';
import { IRS_MILEAGE_RATE } from '../lib/finance';
import { canClaimEarnerPayment } from '../../shared/lifecycle';
import { colors, gradients, shadows } from '../theme';

const TRANSPORT_CATEGORY = 'transport'; // EXPENSE_CATEGORIES id for Transport/Mileage
const todayISO = () => new Date().toISOString().slice(0, 10);
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

// Sanity bounds for auto-tracked drive mileage (it feeds a tax record, so guard it).
const DRIVE_NOISE_FLOOR_MI = 0.2;     // below this is GPS drift, not a real trip → don't log
const DRIVE_SANITY_MAX_MI  = 250;     // above this a tracker was almost certainly left running
const MAX_DRIVE_MS = 4 * 60 * 60 * 1000; // auto-pause the GPS watcher after 4h (battery safety)

const ACTIVE_STATUSES    = new Set(['confirmed', 'completed']); // in progress / needs action
const AWAITING_STATUSES  = new Set(['pending']);                // waiting on poster
const COMPLETED_STATUSES = new Set(['verified', 'declined', 'cancelled']); // finished / closed

// A booking is "action-needed" when the next move in the lifecycle is the EARNER's.
const needsAction = (b) =>
  b.amendmentStatus === 'pending' ||
  (b.status === 'confirmed' && !b.earnerDone) ||
  (b.status === 'verified' && !b.posterRating);

export default function EarnScreen({ navigation }) {
  const {
    earningsToday, earningsWeek, earningsTotal,
    streakDays, levelInfo, xp, challenges,
    weeklyEarningGoal, weeklyJobsGoal, showToast, updateChallenge,
  } = useUser();
  const { bookedJobs, bookings, markEarnerDone, ratePoster, respondToAmendment, cancelBooking, startJob, claimEarnerPayment, refreshBookings, refreshJobs, getPayoutStatus } = useJobs();
  const { user } = useAuth();
  const haptic = useHaptic();
  const [tab, setTab]                   = useState('active'); // 'active' | 'awaiting' | 'completed'
  const [msgTarget, setMsgTarget]       = useState(null);
  const [finishTarget, setFinishTarget] = useState(null); // booking being marked done
  const [finishBeforePhotos, setFinishBeforePhotos] = useState([]); // local "before" URIs to upload
  const [finishPhotos, setFinishPhotos] = useState([]);   // local "after" URIs to upload
  const [finishing, setFinishing]       = useState(false);
  const [rateTarget, setRateTarget]     = useState(null);
  const [posterRating, setPosterRating] = useState(5);
  const [posterReview, setPosterReview] = useState('');
  const [ratingLoading, setRatingLoading] = useState(false);
  const [refreshing, setRefreshing]     = useState(false);
  const [payoutReady, setPayoutReady]   = useState(true); // optimistic until checked
  // Collapsible secondary sections + completed-history expansion.
  // Open by default: it renders only on the Completed tab now, where the month
  // recap is the point of the visit.
  const [showMonth, setShowMonth]       = useState(true);
  const [showGoals, setShowGoals]       = useState(false);
  const [expandedId, setExpandedId]     = useState(null);

  // ── Drive mileage tracking (foreground GPS) ────────────────────────────────
  // Only one drive can track at a time. `driveBookingId` marks which gig owns it.
  const [driveBookingId, setDriveBookingId] = useState(null);
  const [driveMiles, setDriveMiles]         = useState(0);
  const [driveStarting, setDriveStarting]   = useState(false);
  // After a drive ends, offer a one-tap "log the return leg" for that booking.
  const [returnPrompt, setReturnPrompt]     = useState(null); // { bookingId, jobTitle, miles } | null
  const driveSubRef  = useRef(null);   // Location.watchPositionAsync subscription
  const driveLastRef = useRef(null);   // last GPS point {lat, lng}
  const driveMilesRef = useRef(0);     // authoritative accumulator (avoids stale closure)
  const driveTimeoutRef = useRef(null); // safety auto-pause timer

  useEffect(() => {
    getPayoutStatus().then(s => setPayoutReady(s.onboarded));
  }, []);

  // Stop tracking + tear down the GPS subscription. Safe to call multiple times.
  const stopDriveTracking = useCallback(() => {
    if (driveSubRef.current) {
      driveSubRef.current.remove();
      driveSubRef.current = null;
    }
    if (driveTimeoutRef.current) {
      clearTimeout(driveTimeoutRef.current);
      driveTimeoutRef.current = null;
    }
    driveLastRef.current = null;
  }, []);

  // Always clean up the subscription on unmount.
  useEffect(() => stopDriveTracking, [stopDriveTracking]);

  const handleStartDrive = async (booking, jobTitle) => {
    if (driveBookingId || driveStarting) return; // one drive at a time
    setDriveStarting(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        showToast({ icon: '📍', title: 'Location needed to track mileage', message: 'You can still add mileage manually in the Tax Center.' });
        setDriveStarting(false);
        return;
      }
      haptic.medium();
      driveMilesRef.current = 0;
      driveLastRef.current = null;
      setDriveMiles(0);
      setDriveBookingId(booking.id);
      driveSubRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, distanceInterval: 25 },
        (pos) => {
          const pt = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          if (driveLastRef.current) {
            const seg = haversineMiles(driveLastRef.current, pt);
            if (seg && seg > 0) {
              driveMilesRef.current += seg;
              setDriveMiles(driveMilesRef.current);
            }
          }
          driveLastRef.current = pt;
        }
      );
      // Safety: auto-pause an abandoned tracker so it can't run (and drain battery /
      // over-count) indefinitely if the earner forgets to tap "End drive". The
      // accumulated miles are preserved so they can still tap End drive to log them.
      driveTimeoutRef.current = setTimeout(() => {
        stopDriveTracking();
        showToast({ icon: '🚗', title: 'Mileage tracking paused', message: 'Your drive ran for a while — tap End drive to log the distance so far.' });
      }, MAX_DRIVE_MS);
    } catch (e) {
      stopDriveTracking();
      setDriveBookingId(null);
      showToast({ icon: '⚠️', title: 'Could not start tracking', message: e.message || 'Please try again.' });
    }
    setDriveStarting(false);
  };

  // Log one mileage expense for the drive (used for the trip + optional return leg).
  const logDriveExpense = async (booking, jobTitle, miles) => {
    const m = round1(miles);
    const amount = round2(m * IRS_MILEAGE_RATE);
    await addExpense(user.id, {
      userId: user.id,
      category: TRANSPORT_CATEGORY,
      amount,
      description: `Drive — ${jobTitle}`,
      miles: m,
      bookingId: booking.id,
      date: todayISO(),
    });
    return { m, amount };
  };

  const handleEndDrive = async (booking, jobTitle) => {
    stopDriveTracking();
    const tracked = driveMilesRef.current;
    setDriveBookingId(null);
    setDriveMiles(0);
    driveMilesRef.current = 0;
    if (!(tracked >= DRIVE_NOISE_FLOOR_MI)) {
      // Below the noise floor it's GPS drift, not a real trip — don't pollute the tax record.
      showToast({ icon: '🚗', title: 'Drive ended', message: 'Too little distance to log.' });
      return;
    }
    if (tracked > DRIVE_SANITY_MAX_MI) {
      // Implausibly long for a single foreground session — almost certainly a tracker
      // left running. Don't auto-write a bogus figure into the deduction record; let
      // the earner enter the real distance themselves.
      showToast({ icon: '🚗', title: 'That drive looks unusually long', message: `Tracked ${Math.round(tracked)} mi — add the real distance manually in the Tax Center.` });
      return;
    }
    try {
      const { m, amount } = await logDriveExpense(booking, jobTitle, tracked);
      haptic.success();
      showToast({ icon: '🚗', title: `Logged ${m.toFixed(1)} mi → $${amount.toFixed(2)}`, message: 'Saved to your Tax Center.' });
      // Surface a one-tap option to log the round-trip return leg.
      setReturnPrompt({ bookingId: booking.id, jobTitle, miles: m });
    } catch (e) {
      showToast({ icon: '⚠️', title: 'Could not log mileage', message: e.message || 'Add it manually in the Tax Center.' });
    }
  };

  // Log the return leg (same distance) for the just-completed drive.
  const handleLogReturnDrive = async (booking, prompt) => {
    setReturnPrompt(null);
    try {
      const { m, amount } = await logDriveExpense(booking, prompt.jobTitle, prompt.miles);
      haptic.success();
      showToast({ icon: '🚗', title: `Return drive logged → $${amount.toFixed(2)}`, message: `Another ${m.toFixed(1)} mi added.` });
    } catch (e) {
      showToast({ icon: '⚠️', title: 'Could not log return', message: e.message || 'Add it manually in the Tax Center.' });
    }
  };

  // Refresh from DB every time this tab gains focus
  useFocusEffect(
    useCallback(() => {
      refreshBookings();
      refreshJobs();
    }, [])
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refreshBookings(), refreshJobs()]);
    setRefreshing(false);
  };

  const earningPct = Math.min(1, earningsWeek / weeklyEarningGoal);
  // Avg $/job over verified (paid-out) bookings — earnings only accrue on verify.
  const completedCount = (bookings || []).filter(b => b.status === 'verified').length;
  const avgPerJob = completedCount ? earningsTotal / completedCount : 0;
  // Weekly jobs goal counts work that actually FINISHED this week (mutual
  // completion or verified), derived from bookings — not the old apply-time
  // counter, which advanced the moment a gig was booked. Week starts Monday.
  const weekStartMs = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  })();
  const weeklyJobsDone = (bookings || []).filter(b =>
    (b.status === 'completed' || b.status === 'verified')
    && b.completedAt && new Date(b.completedAt).getTime() >= weekStartMs
  ).length;
  const jobsPct    = Math.min(1, weeklyJobsDone / weeklyJobsGoal);

  // Personal insights from this earner's own completed work (null until they have any).
  const insights = computeEarnerInsights(bookings);

  // Pair each booked job with its booking, then split by segment
  const pairs = bookedJobs
    .map(j => ({ job: j, booking: bookings.find(b => b.jobId === j.id) }))
    .filter(p => p.booking);
  const activePairs    = pairs.filter(p => ACTIVE_STATUSES.has(p.booking.status));
  const awaitingPairs  = pairs.filter(p => AWAITING_STATUSES.has(p.booking.status));
  const completedPairs = pairs.filter(p => COMPLETED_STATUSES.has(p.booking.status));
  // In Active, float gigs that need the user's action to the top (stable otherwise).
  const sortedActive   = [...activePairs].sort((a, b) => Number(needsAction(b.booking)) - Number(needsAction(a.booking)));
  const shownPairs     = tab === 'active' ? sortedActive : tab === 'awaiting' ? awaitingPairs : completedPairs;

  // Cross-segment nudges — only render when a decision is actually waiting.
  const pendingAmendCount = (bookings || []).filter(b => b.amendmentStatus === 'pending').length;
  const unratedCount      = (bookings || []).filter(b => b.status === 'verified' && !b.posterRating).length;

  // Earner taps "Start job / I'm on site" → marks the booking in progress.
  const handleStartJob = async (booking) => {
    haptic.medium();
    const ok = await startJob(booking.id);
    if (ok) showToast({ icon: '🚀', title: "You're on the clock", message: 'The poster has been notified that you started.' });
  };

  // Open the finish sheet (lets the earner optionally attach proof photos)
  const handleMarkDone = (booking) => {
    setFinishBeforePhotos([]);
    setFinishPhotos([]);
    setFinishTarget(booking);
  };

  const handleAddBeforePhotos = async () => {
    const res = await pickImages({ multiple: true });
    if (res.canceled) {
      if (res.denied) showToast({ icon: '⚠️', title: 'Photos access needed', message: 'Allow photo access in Settings to attach photos.' });
      return;
    }
    setFinishBeforePhotos(prev => [...prev, ...res.uris].slice(0, 6));
  };

  const handleAddFinishPhotos = async () => {
    const res = await pickImages({ multiple: true });
    if (res.canceled) {
      if (res.denied) showToast({ icon: '⚠️', title: 'Photos access needed', message: 'Allow photo access in Settings to attach photos.' });
      return;
    }
    setFinishPhotos(prev => [...prev, ...res.uris].slice(0, 6));
  };

  const handleConfirmFinish = async () => {
    if (!finishTarget) return;
    setFinishing(true);
    try {
      let urls = null;
      let beforeUrls = null;
      if (finishBeforePhotos.length) {
        beforeUrls = await uploadPrivateImages({ uris: finishBeforePhotos, bucket: 'completion-photos', userId: user.id });
      }
      if (finishPhotos.length) {
        urls = await uploadPrivateImages({ uris: finishPhotos, bucket: 'completion-photos', userId: user.id });
      }
      await markEarnerDone(finishTarget.id, urls, beforeUrls);
      // Progress the "Earn $100 this week" challenge (c2) by the gig's value when the
      // earner completes it — nothing fed it before, so it never moved.
      const cj = finishTarget.job;
      const earned = cj ? (cj.payType === 'hourly' ? Number(cj.pay) * (Number(cj.estimatedHours) || 1) : Number(cj.pay)) : 0;
      if (earned > 0) updateChallenge('c2', earned);
      haptic.success();
      if (finishTarget.posterDone) {
        showToast({ icon: '🎉', title: 'Job Complete!', message: 'Both parties confirmed. Waiting for the poster to verify and rate you.' });
      } else {
        showToast({ icon: '✅', title: 'Marked Done!', message: "We've notified the poster. Waiting for them to confirm." });
      }
      setFinishTarget(null);
      setFinishBeforePhotos([]);
      setFinishPhotos([]);
    } catch (e) {
      showToast({ icon: '⚠️', title: 'Could not finish', message: e.message || 'Please try again.' });
    }
    setFinishing(false);
  };

  const handleCancel = (booking) => {
    const isPending = booking.status === 'pending';
    Alert.alert(
      isPending ? 'Withdraw application?' : 'Cancel booking?',
      isPending
        ? 'This removes your request for this gig.'
        : 'This cancels the confirmed gig and releases any payment hold.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: isPending ? 'Withdraw' : 'Cancel gig', style: 'destructive',
          onPress: () => {
            haptic.medium();
            cancelBooking(booking.id);
            showToast({ icon: '❌', title: isPending ? 'Withdrawn' : 'Booking cancelled', message: isPending ? 'Your request was removed.' : 'The gig was cancelled.' });
          },
        },
      ]
    );
  };

  const handleRatePoster = async () => {
    if (!rateTarget) return;
    setRatingLoading(true);
    haptic.success();
    await ratePoster(rateTarget.id, { rating: posterRating, reviewText: posterReview });
    setRatingLoading(false);
    setRateTarget(null);
    setPosterRating(5);
    setPosterReview('');
    showToast({ icon: '⭐', title: 'Rating Submitted!', message: 'Thanks for rating the poster.' });
  };

  const openRate = (booking) => {
    setPosterRating(5);
    setPosterReview('');
    setRateTarget(booking);
  };

  // Demoted, secondary "Message" affordance for a gig.
  const messageButton = (j, booking) => (
    <TouchableOpacity
      style={styles.msgBtn}
      onPress={() => setMsgTarget({
        bookingId: booking.id,
        jobTitle: j.title,
        otherPerson: { id: j.posterId, name: j.poster?.name || 'Poster', avatarInitial: j.poster?.avatarInitial || 'P', avatarUrl: j.poster?.avatarUrl },
      })}
    >
      <Ionicons name="chatbubble-ellipses-outline" size={15} color={colors.textSecondary} style={{ marginRight: 6 }} />
      <Text style={styles.msgBtnText}>Message</Text>
    </TouchableOpacity>
  );

  // Drive-mileage tracker — demoted to a secondary affordance beneath the primary CTA.
  // Kept on confirmed working gigs (the drive TO the gig happens before "Start job").
  const renderDrive = (j, booking) => (
    <>
      {driveBookingId === booking.id ? (
        <View style={styles.driveTrackingBanner}>
          <View style={styles.driveTrackingLeft}>
            <Ionicons name="navigate" size={16} color="#fff" style={{ marginRight: 7 }} />
            <Text style={styles.driveTrackingText}>Tracking drive · {driveMiles.toFixed(1)} mi</Text>
          </View>
          <TouchableOpacity style={styles.driveEndBtn} onPress={() => handleEndDrive(booking, j.title)}>
            <Text style={styles.driveEndBtnText}>End drive</Text>
          </TouchableOpacity>
        </View>
      ) : !driveBookingId ? (
        <TouchableOpacity
          style={styles.driveStartBtn}
          onPress={() => handleStartDrive(booking, j.title)}
          disabled={driveStarting}
        >
          {driveStarting ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <>
              <Ionicons name="car-outline" size={16} color={colors.primary} style={{ marginRight: 6 }} />
              <Text style={styles.driveStartBtnText}>Start drive · auto-log mileage</Text>
            </>
          )}
        </TouchableOpacity>
      ) : null}

      {returnPrompt?.bookingId === booking.id && (
        <View style={styles.returnPrompt}>
          <Text style={styles.returnPromptText}>Round trip? Log the return drive ({returnPrompt.miles.toFixed(1)} mi).</Text>
          <View style={styles.returnPromptActions}>
            <TouchableOpacity style={styles.returnPromptBtn} onPress={() => handleLogReturnDrive(booking, returnPrompt)}>
              <Ionicons name="repeat" size={14} color="#fff" style={{ marginRight: 5 }} />
              <Text style={styles.returnPromptBtnText}>Log return</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.returnPromptDismiss} onPress={() => setReturnPrompt(null)}>
              <Text style={styles.returnPromptDismissText}>No thanks</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </>
  );

  // H3: after the poster ghosts, offer the earner a way to release the full payment
  // to themselves. Server-authorized (earner-claim-payment) — this is the escalation.
  const handleClaim = (booking) => {
    Alert.alert(
      'Claim your payment?',
      "The poster hasn't confirmed this finished job in time. You can release the full payment to yourself now.",
      [
        { text: 'Not yet', style: 'cancel' },
        { text: 'Claim payment', onPress: () => { haptic.medium(); claimEarnerPayment(booking.id); } },
      ],
    );
  };

  const renderClaimCta = (booking) => {
    if (!canClaimEarnerPayment(booking)) return null;
    return (
      <>
        <TouchableOpacity style={styles.ctaPrimary} onPress={() => handleClaim(booking)}>
          <Ionicons name="cash-outline" size={16} color="#fff" style={{ marginRight: 6 }} />
          <Text style={styles.ctaPrimaryText}>Claim your payment</Text>
        </TouchableOpacity>
        <Text style={styles.helperText}>The poster hasn't confirmed in time — release the full payment to yourself.</Text>
      </>
    );
  };

  // The single, state-derived primary action + demoted secondary controls for a gig.
  const renderActions = (j, booking) => {
    const status = booking.status;

    if (status === 'pending') {
      return (
        <View style={styles.secondaryRow}>
          {messageButton(j, booking)}
          <TouchableOpacity onPress={() => handleCancel(booking)}>
            <Text style={styles.cancelLinkText}>Withdraw application</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (status === 'confirmed' && !booking.startedAt && !booking.earnerDone) {
      return (
        <>
          <TouchableOpacity style={styles.ctaGreen} onPress={() => handleStartJob(booking)}>
            <Ionicons name="play" size={16} color="#fff" style={{ marginRight: 6 }} />
            <Text style={styles.ctaPrimaryText}>Start Job · I'm On Site</Text>
          </TouchableOpacity>
          <Text style={styles.helperText}>Next: tap when you arrive on site.</Text>
          {renderDrive(j, booking)}
          <View style={styles.secondaryRow}>
            {messageButton(j, booking)}
            <TouchableOpacity onPress={() => handleCancel(booking)}>
              <Text style={styles.cancelLinkText}>Cancel booking</Text>
            </TouchableOpacity>
          </View>
        </>
      );
    }

    if (status === 'confirmed' && booking.startedAt && !booking.earnerDone) {
      return (
        <>
          <View style={styles.inProgressBanner}>
            <Ionicons name="ellipse" size={9} color={colors.success} style={{ marginRight: 5 }} />
            <Text style={styles.inProgressText}>In Progress</Text>
          </View>
          <TouchableOpacity style={styles.ctaPrimary} onPress={() => handleMarkDone(booking)}>
            <Ionicons name="checkmark-done" size={16} color="#fff" style={{ marginRight: 6 }} />
            <Text style={styles.ctaPrimaryText}>I Finished This Job</Text>
          </TouchableOpacity>
          <Text style={styles.helperText}>Next: mark the job done when you've finished.</Text>
          {renderDrive(j, booking)}
          <View style={styles.secondaryRow}>
            {messageButton(j, booking)}
            <Text style={styles.cancelLockedText}>Can't cancel — you've started.</Text>
          </View>
        </>
      );
    }

    if (status === 'confirmed' && booking.earnerDone && !booking.posterDone) {
      return (
        <>
          <View style={styles.waitingBanner}>
            <Ionicons name="hourglass-outline" size={13} color="#D97706" style={{ marginRight: 5 }} />
            <Text style={styles.waitingText}>Waiting for poster to confirm done…</Text>
          </View>
          {renderClaimCta(booking)}
          <View style={styles.secondaryRow}>{messageButton(j, booking)}</View>
        </>
      );
    }

    if (status === 'completed') {
      return (
        <>
          <View style={styles.waitingBanner}>
            <Ionicons name="sync-outline" size={13} color="#D97706" style={{ marginRight: 5 }} />
            <Text style={styles.waitingText}>Waiting for the poster to verify & pay.</Text>
          </View>
          {renderClaimCta(booking)}
          <View style={styles.secondaryRow}>{messageButton(j, booking)}</View>
        </>
      );
    }

    return null;
  };

  // Active / Awaiting: rich JobCard + a meta block with one primary action.
  const renderActiveCard = ({ job: j, booking }) => {
    const status = booking.status;
    return (
      <View key={j.id} style={styles.bookedItem}>
        <JobCard job={j} bookingStatus={status} attached onPress={() => navigation.navigate('JobDetail', { jobId: j.id })} />
        <View style={styles.bookingMeta}>
          <BookingStatusBadge status={status} />

          {booking.slotLabel && (
            <View style={styles.bookingRow}>
              <Ionicons name="calendar-outline" size={13} color={colors.textMuted} style={styles.bookingIcon} />
              <Text style={styles.bookingText}>{booking.slotLabel}</Text>
            </View>
          )}
          {booking.counterOffer && (
            <View style={styles.bookingRow}>
              <Ionicons name="chatbubble-outline" size={13} color={colors.textMuted} style={styles.bookingIcon} />
              <Text style={styles.bookingText}>
                Counter-offer: <Text style={styles.bookingBold}>
                  ${booking.counterOffer}{j.payType === 'hourly' ? '/hr' : ' flat'}
                </Text>
              </Text>
            </View>
          )}

          {/* Amendment notifications — a change request requires a decision, so it stays inline */}
          {booking.amendmentStatus === 'pending' && (
            <View style={styles.amendCard}>
              <View style={styles.amendCardTitleRow}>
                <Ionicons name="document-text-outline" size={14} color="#D97706" style={{ marginRight: 6 }} />
                <Text style={styles.amendCardTitle}>Change Proposed by Poster</Text>
              </View>
              <Text style={styles.amendCardNote}>{booking.amendmentNote}</Text>
              <View style={styles.amendCardActions}>
                <TouchableOpacity style={styles.amendAcceptBtn}
                  onPress={() => {
                    respondToAmendment(booking.id, true);
                    showToast({ icon: '✅', title: 'Amendment Accepted', message: 'The poster can now update the gig terms.' });
                  }}>
                  <Ionicons name="checkmark" size={15} color="#fff" style={{ marginRight: 4 }} />
                  <Text style={styles.amendAcceptText}>Accept</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.amendDeclineBtn}
                  onPress={() => {
                    respondToAmendment(booking.id, false);
                    showToast({ icon: '❌', title: 'Amendment Declined', message: 'Original terms remain in effect.' });
                  }}>
                  <Ionicons name="close" size={15} color={colors.textSecondary} style={{ marginRight: 4 }} />
                  <Text style={styles.amendDeclineText}>Decline</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          {booking.amendmentStatus === 'accepted' && (
            <View style={styles.amendStatusBanner}>
              <Text style={styles.amendStatusText}>Change accepted — poster is updating the terms</Text>
            </View>
          )}
          {booking.amendmentStatus === 'declined' && (
            <View style={[styles.amendStatusBanner, { backgroundColor: '#FEF2F2' }]}>
              <Text style={[styles.amendStatusText, { color: '#DC2626' }]}>Change declined — original terms apply</Text>
            </View>
          )}

          {renderActions(j, booking)}
        </View>
      </View>
    );
  };

  // Completed / closed: compact one-line row that expands on tap.
  const renderCompletedRow = ({ job: j, booking }) => {
    const status = booking.status;
    const expanded = expandedId === booking.id;
    const canRate = status === 'verified' && !booking.posterRating;
    const pay = booking.counterOffer || j.pay;
    return (
      <View key={j.id} style={[styles.histRow, canRate && styles.histRowRate]}>
        <View style={styles.histTop}>
          <TouchableOpacity style={styles.histMain} onPress={() => navigation.navigate('JobDetail', { jobId: j.id })} activeOpacity={0.7}>
            <Text style={styles.histTitle} numberOfLines={1}>{j.title}</Text>
            <Text style={styles.histSub} numberOfLines={1}>
              {booking.slotLabel || 'Flexible'} · ${pay}{j.payType === 'hourly' ? '/hr' : ''}
            </Text>
          </TouchableOpacity>
          <BookingStatusBadge status={status} compact />
          {canRate && (
            <TouchableOpacity style={styles.histRateBtn} onPress={() => openRate(booking)}>
              <Ionicons name="star" size={13} color="#fff" style={{ marginRight: 4 }} />
              <Text style={styles.histRateText}>Rate</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.histChevron} onPress={() => setExpandedId(expanded ? null : booking.id)}>
            <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        {expanded && (
          <View style={styles.histDetail}>
            {status === 'verified' && booking.earnerRating ? (
              <View style={styles.verifiedRow}>
                <View style={styles.verifiedStarsRow}>
                  {[1,2,3,4,5].map(s => (
                    <Ionicons key={s} name={s <= Math.round(booking.earnerRating) ? 'star' : 'star-outline'} size={13} color={colors.success} style={{ marginRight: 1 }} />
                  ))}
                  <Text style={styles.verifiedText}>
                    {'  '}{Number(booking.earnerRating).toFixed(1)} from poster
                    {booking.paymentMethod ? ` · Paid via ${booking.paymentMethod}` : ''}
                  </Text>
                </View>
                {booking.reviewText ? <Text style={styles.reviewQuote}>"{booking.reviewText}"</Text> : null}
              </View>
            ) : null}

            {booking.posterRating ? (
              <Text style={styles.posterRatedText}>You rated the poster {booking.posterRating} ★</Text>
            ) : null}

            {booking.beforePhotos?.length > 0 && (
              <View style={styles.photoStrip}>
                <Text style={styles.photoStripLabel}>Before</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  {booking.beforePhotos.map((u, i) => <SignedImage key={i} value={u} bucket="completion-photos" style={styles.photoThumb} />)}
                </ScrollView>
              </View>
            )}
            {booking.completionPhotos?.length > 0 && (
              <View style={styles.photoStrip}>
                <Text style={styles.photoStripLabel}>After</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  {booking.completionPhotos.map((u, i) => <SignedImage key={i} value={u} bucket="completion-photos" style={styles.photoThumb} />)}
                </ScrollView>
              </View>
            )}

            {status === 'verified' && !booking.earnerRating && !booking.posterRating
              && !(booking.beforePhotos?.length) && !(booking.completionPhotos?.length) && (
              <Text style={styles.histEmptyText}>No additional details for this gig.</Text>
            )}
          </View>
        )}
      </View>
    );
  };

  return (
    <ScrollView
      style={styles.container}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      <GradientHeader colors={gradients.earn}>
        <View style={styles.titleRow}>
          <Ionicons name="briefcase" size={22} color="#fff" style={{ marginRight: 8 }} />
          <Text style={styles.screenTitle}>My Jobs</Text>
        </View>
        <View style={styles.headerChipsRow}>
          <View style={styles.weekChip}>
            <Text style={styles.weekChipValue}>${earningsWeek}</Text>
            <Text style={styles.weekChipLabel}>this week</Text>
          </View>
          <View style={styles.streakPill}>
            <Ionicons name="flame" size={15} color="#FB923C" style={{ marginRight: 5 }} />
            <Text style={styles.streakText}>{streakDays}-week streak</Text>
          </View>
          <View style={styles.lvChip}>
            <Ionicons name="star" size={13} color="#FCD34D" style={{ marginRight: 5 }} />
            <Text style={styles.lvChipText}>Lv {levelInfo?.current?.level ?? 1}</Text>
          </View>
        </View>
      </GradientHeader>

      {/* Action-needed band — payout setup (blocks earning) + decision nudges */}
      {!payoutReady && (
        <TouchableOpacity
          style={styles.payoutBanner}
          onPress={() => navigation.navigate('ProfileTab', { screen: 'PayoutSetup', initial: false })}
          activeOpacity={0.85}
        >
          <Ionicons name="wallet-outline" size={20} color="#fff" />
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={styles.payoutBannerTitle}>Set up payouts to get paid</Text>
            <Text style={styles.payoutBannerSub}>Connect your bank to receive earnings →</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.7)" />
        </TouchableOpacity>
      )}

      {(pendingAmendCount > 0 || (unratedCount > 0 && tab !== 'completed')) && (
        <View style={styles.nudgeBand}>
          {pendingAmendCount > 0 && (
            <TouchableOpacity style={[styles.nudge, styles.nudgeAmend]} onPress={() => { haptic.selection(); setTab('active'); }} activeOpacity={0.85}>
              <Ionicons name="document-text-outline" size={18} color={colors.primary} style={{ marginRight: 10 }} />
              <Text style={[styles.nudgeText, { color: colors.primary }]}>
                {pendingAmendCount} change {pendingAmendCount === 1 ? 'request' : 'requests'} to respond to
              </Text>
              <Ionicons name="chevron-forward" size={16} color={colors.primary} />
            </TouchableOpacity>
          )}
          {unratedCount > 0 && tab !== 'completed' && (
            <TouchableOpacity style={[styles.nudge, styles.nudgeRate]} onPress={() => { haptic.selection(); setTab('completed'); }} activeOpacity={0.85}>
              <Ionicons name="star" size={18} color="#D97706" style={{ marginRight: 10 }} />
              <Text style={[styles.nudgeText, { color: '#D97706' }]}>
                Rate {unratedCount} completed {unratedCount === 1 ? 'gig' : 'gigs'} to finish up
              </Text>
              <Ionicons name="chevron-forward" size={16} color="#D97706" />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Segmented control — the spine of the page */}
      <View style={styles.segment}>
        <SegmentBtn label="Active"    count={activePairs.length}    active={tab === 'active'}    onPress={() => { haptic.selection(); setTab('active'); }} />
        <SegmentBtn label="Awaiting"  count={awaitingPairs.length}  active={tab === 'awaiting'}  onPress={() => { haptic.selection(); setTab('awaiting'); }} />
        <SegmentBtn label="Completed" count={completedPairs.length} active={tab === 'completed'} onPress={() => { haptic.selection(); setTab('completed'); }} />
      </View>

      {/* "Your month" — earnings, goal, insights & status. Lives on the Completed
          tab (with the finished work it summarizes) instead of floating below the
          gig list on every tab. */}
      {tab === 'completed' && (
        <CollapsibleSection title="Your month" open={showMonth} onToggle={() => setShowMonth(v => !v)}>
          <MoneyGoalCard navigation={navigation} />

          <View style={styles.breakdownCard}>
            <Text style={styles.insightsTitle}>Earnings</Text>
            <View style={styles.breakdownRow}>
              {[
                { label: 'Today',     value: `$${earningsToday}` },
                { label: 'This week', value: `$${earningsWeek}` },
                { label: 'All time',  value: `$${earningsTotal.toLocaleString()}` },
                { label: 'Avg/job',   value: completedCount ? `$${Math.round(avgPerJob).toLocaleString()}` : '—' },
              ].map(s => (
                <View key={s.label} style={styles.breakdownTile}>
                  <Text style={styles.breakdownVal}>{s.value}</Text>
                  <Text style={styles.breakdownLabel}>{s.label}</Text>
                </View>
              ))}
            </View>
          </View>

          {insights && insights.jobCount > 0 && (
            <View style={styles.insightsCard}>
              <Text style={styles.insightsTitle}>Your insights</Text>
              <View style={styles.insightsRow}>
                <InsightTile icon="location-outline" label="Top area" value={insights.topArea?.label || '—'} />
                <InsightTile icon="calendar-outline" label="Busiest" value={insights.busiestDay?.label || '—'} />
                <InsightTile
                  icon="cash-outline"
                  label="Best day"
                  value={insights.mostProfitableDay
                    ? `${insights.mostProfitableDay.label} ($${Math.round(insights.mostProfitableDay.total).toLocaleString()})`
                    : '—'}
                />
              </View>
            </View>
          )}

          <WorkStatusBar />
        </CollapsibleSection>
      )}

      {/* The booked-gig list — the primary content */}
      <View style={styles.section}>
        {shownPairs.length === 0 && (
          <View style={styles.noGigsCard}>
            <Ionicons
              name={tab === 'active' ? 'briefcase-outline' : tab === 'awaiting' ? 'hourglass-outline' : 'checkmark-done-circle-outline'}
              size={42} color={colors.textMuted} style={{ marginBottom: 12 }}
            />
            <Text style={styles.emptyTitle}>
              {tab === 'active' ? 'No active jobs' : tab === 'awaiting' ? 'Nothing awaiting' : 'No completed jobs yet'}
            </Text>
            <Text style={styles.emptyText}>
              {tab === 'active'
                ? 'Jobs you’re actively working show up here. Find one in the Browse tab!'
                : tab === 'awaiting'
                  ? 'Gigs you’ve applied to — waiting on the poster to accept — appear here.'
                  : 'Completed and closed gigs will show up here.'}
            </Text>
          </View>
        )}

        {tab === 'completed'
          ? shownPairs.map(renderCompletedRow)
          : shownPairs.map(renderActiveCard)}
      </View>

      {/* "Goals & challenges" — gamification, lowest priority */}
      <CollapsibleSection title="Goals & challenges" open={showGoals} onToggle={() => setShowGoals(v => !v)}>
        <View style={styles.goalsXp}>
          <XPBar levelInfo={levelInfo} xp={xp} dark={false} />
        </View>
        <View style={styles.goalsCard}>
          <GoalBar label="Earnings"  value={`$${earningsWeek}`}  max={`$${weeklyEarningGoal}`} pct={earningPct} color={colors.accent} />
          <View style={{ height: 14 }} />
          <GoalBar label="Jobs Done" value={`${weeklyJobsDone}`} max={`${weeklyJobsGoal} gigs`} pct={jobsPct} color={colors.primary} />
        </View>
        <View style={styles.challengesWrap}>
          {challenges.map(c => <ChallengeCard key={c.id} challenge={c} />)}
        </View>
      </CollapsibleSection>

      <View style={{ height: 30 }} />

      <MessageSheet
        visible={!!msgTarget}
        bookingId={msgTarget?.bookingId}
        jobTitle={msgTarget?.jobTitle}
        otherPerson={msgTarget?.otherPerson}
        onClose={() => setMsgTarget(null)}
      />

      {/* Rate Poster Modal */}
      <Modal visible={!!rateTarget} animationType="slide" transparent onRequestClose={() => setRateTarget(null)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setRateTarget(null)} />
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Rate the Poster</Text>
            <Text style={styles.modalSub}>
              How was {rateTarget?.job?.title || 'this gig'} as an employer?
            </Text>

            {/* Stars */}
            <View style={styles.starRow}>
              {[1,2,3,4,5].map(s => (
                <TouchableOpacity key={s} onPress={() => { haptic.selection(); setPosterRating(s); }} style={{ marginRight: 4 }}>
                  <Ionicons name={s <= posterRating ? 'star' : 'star-outline'} size={34} color={s <= posterRating ? '#F59E0B' : colors.border} />
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.ratingLabel}>
              {posterRating === 5 ? 'Excellent employer!' : posterRating === 4 ? 'Great experience' : posterRating === 3 ? 'It was okay' : posterRating === 2 ? 'Some issues' : 'Poor experience'}
            </Text>

            <TextInput
              style={styles.reviewInput}
              placeholder="Leave a comment (optional)…"
              placeholderTextColor={colors.textMuted}
              value={posterReview}
              onChangeText={setPosterReview}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
              maxLength={280}
            />

            <TouchableOpacity onPress={handleRatePoster} disabled={ratingLoading} activeOpacity={0.85}>
              <LinearGradient colors={gradients.earn} style={styles.submitBtn}>
                {ratingLoading
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.submitBtnText}>Submit Rating</Text>
                }
              </LinearGradient>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setRateTarget(null)} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Finish Job Modal — optional proof photos */}
      <Modal visible={!!finishTarget} animationType="slide" transparent onRequestClose={() => !finishing && setFinishTarget(null)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => !finishing && setFinishTarget(null)} />
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Finish this job</Text>
            <Text style={styles.modalSub}>
              Add before & after photos of your work (optional). The poster sees these when verifying.
            </Text>

            <Text style={styles.finishPhotoLabel}>Before photos (optional)</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 18 }}>
              {finishBeforePhotos.map((u, i) => (
                <View key={i} style={styles.finishThumbWrap}>
                  <Image source={{ uri: u }} style={styles.finishThumb} />
                  <TouchableOpacity
                    style={styles.finishThumbRemove}
                    onPress={() => setFinishBeforePhotos(prev => prev.filter((_, idx) => idx !== i))}
                  >
                    <Ionicons name="close" size={13} color="#fff" />
                  </TouchableOpacity>
                </View>
              ))}
              {finishBeforePhotos.length < 6 && (
                <TouchableOpacity style={styles.addPhotoTile} onPress={handleAddBeforePhotos}>
                  <Ionicons name="camera-outline" size={24} color={colors.primary} />
                  <Text style={styles.addPhotoText}>Add</Text>
                </TouchableOpacity>
              )}
            </ScrollView>

            <Text style={styles.finishPhotoLabel}>After photos (optional)</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 20 }}>
              {finishPhotos.map((u, i) => (
                <View key={i} style={styles.finishThumbWrap}>
                  <Image source={{ uri: u }} style={styles.finishThumb} />
                  <TouchableOpacity
                    style={styles.finishThumbRemove}
                    onPress={() => setFinishPhotos(prev => prev.filter((_, idx) => idx !== i))}
                  >
                    <Ionicons name="close" size={13} color="#fff" />
                  </TouchableOpacity>
                </View>
              ))}
              {finishPhotos.length < 6 && (
                <TouchableOpacity style={styles.addPhotoTile} onPress={handleAddFinishPhotos}>
                  <Ionicons name="camera-outline" size={24} color={colors.primary} />
                  <Text style={styles.addPhotoText}>Add</Text>
                </TouchableOpacity>
              )}
            </ScrollView>

            <TouchableOpacity onPress={handleConfirmFinish} disabled={finishing} activeOpacity={0.85}>
              <LinearGradient colors={gradients.earn} style={styles.submitBtn}>
                {finishing
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.submitBtnText}>{(finishPhotos.length || finishBeforePhotos.length) ? 'Submit & Mark Complete' : 'Mark Complete'}</Text>
                }
              </LinearGradient>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => !finishing && setFinishTarget(null)} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function CollapsibleSection({ title, open, onToggle, children }) {
  return (
    <View>
      <TouchableOpacity style={styles.collapseHeader} onPress={onToggle} activeOpacity={0.7}>
        <Text style={styles.collapseTitle}>{title}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
      </TouchableOpacity>
      {open && <View style={styles.collapseBody}>{children}</View>}
    </View>
  );
}

function SegmentBtn({ label, count, active, onPress }) {
  return (
    <TouchableOpacity style={[styles.segBtn, active && styles.segBtnActive]} onPress={onPress} activeOpacity={0.8}>
      <Text style={[styles.segText, active && styles.segTextActive]}>
        {label}{count > 0 ? ` (${count})` : ''}
      </Text>
    </TouchableOpacity>
  );
}

function InsightTile({ icon, label, value }) {
  return (
    <View style={styles.insightTile}>
      <Ionicons name={icon} size={16} color={colors.primary} style={{ marginBottom: 4 }} />
      <Text style={styles.insightLabel}>{label}</Text>
      <Text style={styles.insightValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function GoalBar({ label, value, max, pct, color }) {
  return (
    <View>
      <View style={styles.goalHeader}>
        <Text style={styles.goalLabel}>{label}</Text>
        <Text style={[styles.goalValue, { color }]}>{value} / {max}</Text>
      </View>
      <View style={styles.goalTrack}>
        <View style={[styles.goalFill, { width: `${Math.round(pct * 100)}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  payoutBanner: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#3F25FE',
    marginHorizontal: 16, marginTop: 12,
    borderRadius: 14, padding: 14,
  },
  payoutBannerTitle: { color: '#fff', fontSize: 13, fontWeight: '700' },
  payoutBannerSub: { color: 'rgba(255,255,255,0.75)', fontSize: 12, marginTop: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  screenTitle: { fontSize: 22, fontWeight: '800', color: '#fff' },
  // Header chips (replaces the old 4-tile earnings wall + full XP bar)
  headerChipsRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  weekChip: {
    flexDirection: 'row', alignItems: 'baseline',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8,
  },
  weekChipValue: { fontSize: 17, fontWeight: '900', color: '#fff' },
  weekChipLabel: { fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.75)', marginLeft: 6 },
  streakPill: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8,
  },
  streakText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  lvChip: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8,
  },
  lvChipText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  // Action-needed nudge band
  nudgeBand: { marginHorizontal: 16, marginTop: 12, gap: 8 },
  nudge: { flexDirection: 'row', alignItems: 'center', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12 },
  nudgeAmend: { backgroundColor: colors.primaryLight },
  nudgeRate: { backgroundColor: colors.goldLight },
  nudgeText: { flex: 1, fontSize: 13, fontWeight: '800' },
  insightsCard: {
    marginHorizontal: 16, marginTop: 12,
    backgroundColor: colors.surface, borderRadius: 18, padding: 16,
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  insightsTitle: {
    fontSize: 12, fontWeight: '800', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 12,
  },
  insightsRow: { flexDirection: 'row', gap: 8 },
  insightTile: {
    flex: 1, backgroundColor: colors.surfaceAlt || colors.background,
    borderRadius: 12, paddingVertical: 12, paddingHorizontal: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  insightLabel: { fontSize: 10, fontWeight: '700', color: colors.textMuted, marginBottom: 2 },
  insightValue: { fontSize: 13, fontWeight: '800', color: colors.textPrimary },
  // Earnings breakdown grid (moved out of the header into "Your month")
  breakdownCard: {
    marginHorizontal: 16, marginTop: 12,
    backgroundColor: colors.surface, borderRadius: 18, padding: 16,
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  breakdownRow: { flexDirection: 'row', gap: 8 },
  breakdownTile: { flex: 1, backgroundColor: colors.background, borderRadius: 12, paddingVertical: 10, alignItems: 'center' },
  breakdownVal: { fontSize: 15, fontWeight: '900', color: colors.textPrimary },
  breakdownLabel: { fontSize: 10.5, color: colors.textMuted, marginTop: 2 },
  segment: {
    flexDirection: 'row', marginHorizontal: 16, marginTop: 16,
    backgroundColor: colors.surface, borderRadius: 14, padding: 4,
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  segBtn: { flex: 1, paddingVertical: 12, alignItems: 'center', borderRadius: 10 },
  segBtnActive: { backgroundColor: colors.primary },
  segText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  segTextActive: { color: '#fff' },
  section: { paddingHorizontal: 16, marginTop: 16 },
  // Collapsible secondary sections
  collapseHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginHorizontal: 16, marginTop: 24,
    backgroundColor: colors.surface, borderRadius: 14,
    paddingHorizontal: 16, paddingVertical: 14,
    borderWidth: 1, borderColor: colors.border,
  },
  collapseTitle: { fontSize: 14, fontWeight: '800', color: colors.textPrimary },
  collapseBody: { marginTop: 2, marginBottom: 4 },
  goalsXp: {
    marginHorizontal: 16, marginTop: 12,
    backgroundColor: colors.surface, borderRadius: 18, padding: 16,
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  goalsCard: {
    marginHorizontal: 16, marginTop: 12, padding: 16,
    backgroundColor: colors.surface, borderRadius: 18,
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  challengesWrap: { paddingHorizontal: 16, marginTop: 12 },
  goalHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  goalLabel: { fontSize: 13, fontWeight: '700', color: colors.textPrimary },
  goalValue: { fontSize: 13, fontWeight: '700' },
  goalTrack: { height: 10, borderRadius: 5, backgroundColor: colors.divider, overflow: 'hidden' },
  goalFill: { height: 10, borderRadius: 5 },
  bookedItem: { marginBottom: 0 },
  // Sits flush under an attached JobCard (square bottom) so the pair reads as ONE
  // card: rounded top (card) + rounded bottom (this panel). Width must match the
  // card's marginHorizontal, and only a hairline divider separates the two.
  bookingMeta: {
    backgroundColor: colors.surface, borderRadius: 20,
    paddingHorizontal: 14, paddingVertical: 12,
    marginHorizontal: 16, marginBottom: 16,
    borderTopWidth: 1, borderTopColor: colors.divider,
    borderTopLeftRadius: 0, borderTopRightRadius: 0,
    ...shadows.card,
  },
  bookingRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 8 },
  bookingIcon: { marginRight: 6, marginTop: 2 },
  bookingText: { fontSize: 12, color: colors.textSecondary, flex: 1, lineHeight: 18 },
  bookingBold: { fontWeight: '800', color: colors.primary },
  // Compact completed-history rows
  histRow: {
    backgroundColor: colors.surface, borderRadius: 16,
    marginBottom: 12, borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
  },
  histRowRate: { borderLeftWidth: 4, borderLeftColor: colors.gold },
  histTop: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, gap: 8 },
  histMain: { flex: 1, minWidth: 0 },
  histTitle: { fontSize: 15, fontWeight: '800', color: colors.textPrimary },
  histSub: { fontSize: 12.5, color: colors.textSecondary, marginTop: 2 },
  histRateBtn: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.primary,
    borderRadius: 10, paddingVertical: 9, paddingHorizontal: 10,
  },
  histRateText: { fontSize: 12, fontWeight: '800', color: '#fff' },
  histChevron: { paddingVertical: 10, paddingHorizontal: 8, marginRight: -8 },
  histDetail: { borderTopWidth: 1, borderTopColor: colors.divider, paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
  histEmptyText: { fontSize: 13, color: colors.textMuted },
  inProgressBanner: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#ECFDF5', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6, marginTop: 8, alignSelf: 'flex-start',
  },
  inProgressText: { fontSize: 12, fontWeight: '700', color: colors.success },
  amendCard: {
    backgroundColor: '#FFFBEB', borderRadius: 12, padding: 12, marginTop: 10,
    borderWidth: 1.5, borderColor: '#FCD34D',
  },
  amendCardTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  amendCardTitle: { fontSize: 13, fontWeight: '800', color: '#D97706' },
  amendCardNote: { fontSize: 13, color: colors.textPrimary, lineHeight: 19, marginBottom: 10 },
  amendCardActions: { flexDirection: 'row', gap: 10 },
  amendAcceptBtn: {
    flex: 1, flexDirection: 'row', backgroundColor: colors.success, borderRadius: 10,
    paddingVertical: 10, alignItems: 'center', justifyContent: 'center',
  },
  amendAcceptText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  amendDeclineBtn: {
    flex: 1, flexDirection: 'row', backgroundColor: colors.surface, borderRadius: 10,
    paddingVertical: 10, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: colors.border,
  },
  amendDeclineText: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  amendStatusBanner: {
    backgroundColor: '#ECFDF5', borderRadius: 8, padding: 9, marginTop: 8,
  },
  amendStatusText: { fontSize: 12, fontWeight: '600', color: '#059669' },
  waitingBanner: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#FFF7ED', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6, marginTop: 8, alignSelf: 'flex-start',
  },
  waitingText: { fontSize: 12, fontWeight: '600', color: '#D97706' },
  // One primary CTA per gig
  ctaPrimary: {
    flexDirection: 'row', backgroundColor: colors.primary, borderRadius: 12,
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center', marginTop: 12,
  },
  ctaGreen: {
    flexDirection: 'row', backgroundColor: colors.success, borderRadius: 12,
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center', marginTop: 12,
  },
  ctaPrimaryText: { fontSize: 14, fontWeight: '800', color: '#fff' },
  helperText: { fontSize: 12, color: colors.textMuted, marginTop: 8 },
  secondaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 12 },
  driveStartBtn: {
    flexDirection: 'row', borderRadius: 12, paddingVertical: 12, marginTop: 10,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: colors.primary, backgroundColor: colors.primaryLight,
  },
  driveStartBtnText: { fontSize: 13, fontWeight: '800', color: colors.primary },
  driveTrackingBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, marginTop: 10,
  },
  driveTrackingLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  driveTrackingText: { fontSize: 13, fontWeight: '800', color: '#fff' },
  driveEndBtn: {
    backgroundColor: 'rgba(255,255,255,0.22)', borderRadius: 9,
    paddingVertical: 6, paddingHorizontal: 12,
  },
  driveEndBtnText: { fontSize: 12, fontWeight: '800', color: '#fff' },
  returnPrompt: {
    backgroundColor: colors.primaryLight, borderRadius: 12, padding: 12, marginTop: 10,
    borderWidth: 1, borderColor: colors.primary + '40',
  },
  returnPromptText: { fontSize: 12.5, fontWeight: '700', color: colors.textPrimary, marginBottom: 10 },
  returnPromptActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  returnPromptBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 14,
  },
  returnPromptBtnText: { fontSize: 12.5, fontWeight: '800', color: '#fff' },
  returnPromptDismiss: { paddingVertical: 9, paddingHorizontal: 8 },
  returnPromptDismissText: { fontSize: 12.5, fontWeight: '700', color: colors.textMuted },
  verifiedRow: {
    backgroundColor: colors.successLight, borderRadius: 10,
    padding: 10,
  },
  verifiedStarsRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  verifiedText: { fontSize: 13, fontWeight: '700', color: colors.success },
  reviewQuote: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', marginTop: 3 },
  posterRatedText: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic' },
  msgBtn: {
    flexDirection: 'row', borderRadius: 12, paddingVertical: 11, paddingHorizontal: 14,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface,
  },
  msgBtnText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  cancelLinkText: { fontSize: 13, fontWeight: '700', color: colors.urgent, paddingVertical: 10 },
  cancelLockedText: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', flexShrink: 1, textAlign: 'right' },
  photoStrip: {},
  photoStripLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 },
  photoThumb: { width: 64, height: 64, borderRadius: 10, marginRight: 8, backgroundColor: colors.border },
  finishThumbWrap: { marginRight: 10 },
  finishThumb: { width: 80, height: 80, borderRadius: 12, backgroundColor: colors.border },
  finishThumbRemove: {
    position: 'absolute', top: -6, right: -6,
    width: 22, height: 22, borderRadius: 11, backgroundColor: colors.urgent,
    alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff',
  },
  addPhotoTile: {
    width: 80, height: 80, borderRadius: 12, borderWidth: 1.5, borderColor: colors.primary,
    borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primaryLight,
  },
  addPhotoText: { fontSize: 11, fontWeight: '700', color: colors.primary, marginTop: 2 },
  noGigsCard: {
    backgroundColor: colors.surface, borderRadius: 16, paddingVertical: 36, paddingHorizontal: 24,
    alignItems: 'center', borderWidth: 1, borderColor: colors.border,
  },
  emptyTitle: { fontSize: 17, fontWeight: '800', color: colors.textPrimary, marginBottom: 6 },
  emptyText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  // Rate poster modal
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  modalSheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: 24, paddingBottom: 40, ...shadows.md,
  },
  modalHandle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border,
    alignSelf: 'center', marginTop: 12, marginBottom: 20,
  },
  modalTitle: { fontSize: 22, fontWeight: '900', color: colors.textPrimary, marginBottom: 6 },
  modalSub: { fontSize: 14, color: colors.textSecondary, marginBottom: 20 },
  finishPhotoLabel: { fontSize: 12, fontWeight: '700', color: colors.textMuted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.4 },
  starRow: { flexDirection: 'row', marginBottom: 8 },
  ratingLabel: { fontSize: 13, color: colors.textMuted, fontStyle: 'italic', marginBottom: 16 },
  reviewInput: {
    backgroundColor: colors.background, borderRadius: 14,
    borderWidth: 1.5, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 14, color: colors.textPrimary, minHeight: 80, marginBottom: 20,
  },
  submitBtn: { borderRadius: 16, paddingVertical: 17, alignItems: 'center' },
  submitBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  cancelBtn: { paddingVertical: 14, alignItems: 'center' },
  cancelText: { fontSize: 14, color: colors.textMuted, fontWeight: '600' },
});
