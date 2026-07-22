import React, { useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, TextInput, Image, Modal, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import PosterTrustCard from '../components/PosterTrustCard';
import SlotPicker from '../components/SlotPicker';
import RatingStars from '../components/RatingStars';
import { useJobs } from '../context/JobsContext';
import { useUser } from '../context/UserContext';
import { useAuth } from '../context/AuthContext';
import { useHaptic } from '../hooks/useHaptic';
import { supabase } from '../lib/supabase';
import { maskLocation, canSeeExactAddress } from '../lib/address';
import { colors, radii, shadows } from '../theme';
import MessageSheet from '../components/MessageSheet';
import { submitReport, REPORT_REASONS } from '../lib/moderation';
import { findProhibited } from '../lib/contentFilter';
import { logModerationBlock } from '../lib/moderation';
import { SERVICE_FEE_PCT } from '../lib/stripeClient';

const STATUS_CONTENT = {
  pending:   { ion: 'time', title: 'Application pending',
               desc: "The poster hasn't reviewed your booking yet. Hang tight!",
               bg: colors.accentLight, color: colors.accentDeep },
  confirmed: { ion: 'checkmark-circle', title: "Confirmed — you're in",
               desc: 'Accepted! Head to the Earn tab to mark done when finished.',
               bg: colors.successLight, color: colors.success },
  completed: { ion: 'sync', title: 'Awaiting verification',
               desc: 'You marked done. The poster needs to verify your work.',
               bg: colors.background, color: colors.textPrimary },
  verified:  { ion: 'shield-checkmark', title: 'Completed & verified',
               desc: 'All done! Go to the Earn tab to rate the poster.',
               bg: colors.successLight, color: colors.success },
  declined:  { ion: 'close-circle', title: 'Application declined',
               desc: "The poster didn't accept your booking.",
               bg: colors.urgentLight, color: colors.urgent },
};

const RECUR_LABEL = { weekly: 'Weekly', biweekly: 'Biweekly', monthly: 'Monthly' };

export default function JobDetailScreen({ route, navigation }) {
  const { jobId } = route.params;
  const { jobs, bookings, posterBookings, bookJob, isBooked, savedJobIds, toggleSavedJob, fetchJobById } = useJobs();
  const { addXP, updateChallenge, showToast } = useUser();
  const { user } = useAuth();
  const haptic = useHaptic();
  const insets = useSafeAreaInsets();

  // Not every viewable job is in the browse list — conversation links can point
  // at past (soft-cancelled) listings, so fall back to a direct fetch.
  const [fetchedJob, setFetchedJob] = useState(null);
  const [fetchTried, setFetchTried] = useState(false);
  const listJob = jobs.find(j => j.id === jobId);
  const job = listJob || fetchedJob;
  React.useEffect(() => {
    if (listJob || fetchTried) return;
    let active = true;
    fetchJobById(jobId)
      .then(j => { if (active) setFetchedJob(j); })
      .finally(() => { if (active) setFetchTried(true); });
    return () => { active = false; };
  }, [jobId, listJob, fetchTried]);

  // The Browse/Earn/Gigs feed no longer joins reviews(*) (bounded payload), so a job
  // opened from a list arrives with reviews:[]. Load this job's reviews directly on
  // mount so the detail view still shows them, shaped like transformJob's reviews.
  const [jobReviews, setJobReviews] = useState(null);
  React.useEffect(() => {
    let active = true;
    supabase.from('reviews')
      .select('id, author, rating, text, date')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (active) setJobReviews((data || []).map(r => ({
          id: r.id, author: r.author, rating: Number(r.rating), text: r.text, date: r.date,
        })));
      });
    return () => { active = false; };
  }, [jobId]);

  const [selectedSlot, setSelectedSlot] = useState(null);
  const [counterPrice, setCounterPrice] = useState('');
  const [applicationNote, setApplicationNote] = useState('');
  const [msgVisible, setMsgVisible] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const alreadyBooked = isBooked(jobId);
  const isOwnJob = job?.posterId && user?.id && job.posterId === user.id;
  const currentBooking = bookings.find(b => b.jobId === jobId);
  const jobPosterBookings = posterBookings.filter(b => b.jobId === jobId);

  // jobs.location is masked server-side (migration 20260722040000); the exact address
  // lives in job_locations, readable only by the poster or an accepted earner via RLS.
  // Fetch it for an authorized viewer so the "address after acceptance" reveal holds.
  const [exactLocation, setExactLocation] = useState(null);
  React.useEffect(() => {
    const canSee = canSeeExactAddress({ isPoster: !!isOwnJob, bookingStatus: currentBooking?.status });
    if (!job?.id || !canSee) { setExactLocation(null); return; }
    let active = true;
    supabase.from('job_locations').select('exact_location').eq('job_id', job.id).maybeSingle()
      .then(
        ({ data }) => { if (active) setExactLocation(data?.exact_location || null); },
        () => { if (active) setExactLocation(null); },
      );
    return () => { active = false; };
  }, [job?.id, isOwnJob, currentBooking?.status]);

  if (!job) {
    return (
      <View style={[styles.container, { alignItems: 'center', justifyContent: 'center', padding: 24 }]}>
        {fetchTried
          ? <Text style={{ fontSize: 15, color: colors.textSecondary, textAlign: 'center' }}>This gig is no longer available.</Text>
          : <ActivityIndicator color={colors.primary} />}
      </View>
    );
  }

  const statusContent = STATUS_CONTENT[currentBooking?.status] || STATUS_CONTENT.pending;
  const canMessage = !!currentBooking && ['pending','confirmed','completed'].includes(currentBooking.status);

  // Address privacy: exact street address only for the poster or an accepted
  // earner; everyone else sees the city-level label (coords are already ~1km).
  const showExactAddress = canSeeExactAddress({ isPoster: isOwnJob, bookingStatus: currentBooking?.status });
  // job.location is already the masked label from the server; the exact address (when
  // the viewer is entitled to it) is fetched separately into exactLocation.
  const displayLocation = showExactAddress ? (exactLocation || job.location) : maskLocation(job.location);
  // Mirror web: hint that a precise address exists for any non-remote gig the viewer
  // isn't yet entitled to (the exact value is withheld server-side, so we can't detect
  // it from the already-masked label).
  const addressMasked = !showExactAddress && !String(job.location || '').toLowerCase().includes('remote');

  // Prefer reviews loaded on demand; fall back to whatever came with the job (the
  // fetchJobById path still embeds them) until the direct load resolves.
  const displayReviews = jobReviews ?? job.reviews ?? [];

  const estPay = job.payType === 'hourly'
    ? `$${job.pay}/hr · ~$${job.pay * job.estimatedHours} estimated`
    : `$${job.pay} flat rate`;

  // A custom reason sheet — NOT Alert.alert, which caps at 3 buttons on Android and
  // would silently drop most of the 5 report reasons (same bug the chat report flow
  // hit and fixed with a modal).
  const handleReportGig = () => { haptic.light(); setReportOpen(true); };
  const doReportGig = async (reason) => {
    setReportOpen(false);
    try {
      await submitReport({ reporterId: user.id, reportedUserId: job.posterId, jobId: job.id, reason });
      showToast({ icon: '🚩', title: 'Report submitted', message: 'Thanks — our team will review this gig.' });
    } catch (e) {
      showToast({ icon: '⚠️', title: "Couldn't submit", message: e.message || 'Please try again.' });
    }
  };

  const handleBook = async () => {
    // A slot is selectable only if it's untaken AND not in the past — mirror
    // SlotPicker, which HIDES past slots. Counting past slots as "available" made
    // a gig whose only slots have passed demand a selection the UI never shows,
    // so Book just buzzed with no explanation (a dead-end).
    const now = Date.now();
    const selectableSlots = (job.slots || []).filter(s => !s.taken && (!s.startsAt || new Date(s.startsAt).getTime() > now));
    const hasScheduledSlots = (job.slots || []).some(s => s.startsAt);
    if (hasScheduledSlots && selectableSlots.length === 0) {
      haptic.error();
      showToast({ icon: '🕒', title: 'No available times', message: "This gig's time slots have all passed. Message the poster to arrange a new time." });
      return;
    }
    if (!selectedSlot && selectableSlots.length > 0) {
      haptic.error();
      showToast({ icon: '👆', title: 'Pick a time', message: 'Select an available time slot to book this gig.' });
      return;
    }
    const slot = job.slots?.find(s => s.id === selectedSlot);
    const counter = counterPrice ? parseFloat(counterPrice) : null;
    const note = applicationNote.trim() || null;
    const noteTerm = note && findProhibited(note);
    if (noteTerm) {
      logModerationBlock(noteTerm, 'note', note);
      haptic.error();
      showToast({ icon: '⚠️', title: 'Check your wording', message: "Your note contains content that isn't allowed. Please edit it." });
      return;
    }
    const ok = await bookJob(jobId, selectedSlot, slot?.label, counter, note);
    if (!ok) {
      // The booking didn't persist — don't award XP/challenges or claim success.
      haptic.error();
      showToast({ icon: '⚠️', title: "Couldn't book", message: 'That gig could not be booked. Please try again.' });
      return;
    }
    haptic.success();
    addXP(25);
    updateChallenge('c1', 1);
    if (job.category === 'Tech Help') updateChallenge('c3', 1);

    const counterMsg = counter
      ? ` · Counter-offer $${counter}${job.payType === 'hourly' ? '/hr' : ''} sent!`
      : '';
    showToast({
      icon: '🎉',
      title: 'Gig Booked! +25 XP',
      message: `"${job.title}" booked${counterMsg}`,
    });
    navigation.navigate('EarnTab');
  };

  return (
    <View style={styles.container}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}
        automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">
        {job.urgent && (
          <View style={styles.urgentBanner}>
            <Ionicons name="flash" size={14} color={colors.urgent} style={{ marginRight: 6 }} />
            <Text style={styles.urgentText} numberOfLines={1}>Urgent — needed ASAP</Text>
          </View>
        )}

        <View style={styles.catRow}>
          <Text style={styles.catText} numberOfLines={1}>{job.category}</Text>
          <TouchableOpacity
            style={styles.saveBtn}
            onPress={() => { haptic.light(); toggleSavedJob(job.id); }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={savedJobIds.has(job.id) ? 'Unsave gig' : 'Save gig'}
          >
            <Ionicons
              name={savedJobIds.has(job.id) ? 'bookmark' : 'bookmark-outline'}
              size={20}
              color={savedJobIds.has(job.id) ? colors.primary : colors.textMuted}
            />
          </TouchableOpacity>
        </View>

        <Text style={styles.title}>{job.title}</Text>

        <View style={styles.pillRow}>
          <View style={styles.payPill}>
            <Ionicons name="cash" size={14} color={colors.accentDeep} style={{ marginRight: 5 }} />
            <Text style={styles.payText} numberOfLines={1}>{estPay}</Text>
          </View>
          <View style={styles.locPill}>
            <Ionicons name="location" size={13} color={colors.textSecondary} style={{ marginRight: 4 }} />
            <Text style={styles.locText} numberOfLines={1}>{displayLocation}</Text>
          </View>
          {RECUR_LABEL[job.recurrence] && (
            <View style={styles.recurPill}>
              <Ionicons name="repeat" size={13} color={colors.textSecondary} style={{ marginRight: 4 }} />
              <Text style={styles.recurPillText} numberOfLines={1}>Repeats {RECUR_LABEL[job.recurrence]}</Text>
            </View>
          )}
        </View>

        {addressMasked && (
          <View style={styles.addressHint}>
            <Ionicons name="lock-closed-outline" size={13} color={colors.textMuted} style={{ marginRight: 6, marginTop: 2 }} />
            <Text style={styles.addressHintText}>The full address is shown here after the poster accepts your booking.</Text>
          </View>
        )}

        {job.photos?.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.gallery}
            contentContainerStyle={{ paddingRight: 8 }}
          >
            {job.photos.map((u, i) => (
              <Image key={i} source={{ uri: u }} style={styles.galleryImg} />
            ))}
          </ScrollView>
        )}

        <Section title="About this gig">
          <Text style={styles.description}>{job.description}</Text>
          {job.tags?.length > 0 && (
            <View style={styles.tagRow}>
              {job.tags.map(t => (
                <View key={t} style={styles.tagChip}><Text style={styles.tagText}>#{t}</Text></View>
              ))}
            </View>
          )}
        </Section>

        {job.hazards?.length > 0 && (
          <View style={styles.hazardCard}>
            <View style={styles.hazardHeader}>
              <Ionicons name="warning" size={18} color={colors.urgent} style={{ marginRight: 7 }} />
              <Text style={styles.hazardTitle} numberOfLines={1}>Safety notes</Text>
            </View>
            {job.hazards.map((h, i) => (
              <View key={i} style={styles.hazardRow}>
                <Ionicons name="alert-circle" size={14} color={colors.urgent} style={{ marginRight: 7, marginTop: 2 }} />
                <Text style={styles.hazardText}>{h}</Text>
              </View>
            ))}
          </View>
        )}

        {job.requirements?.length > 0 && (
          <Section title="Requirements">
            {job.requirements.map((r, i) => (
              <View key={i} style={styles.reqRow}>
                <Text style={styles.reqDot}>•</Text>
                <Text style={styles.reqText}>{r}</Text>
              </View>
            ))}
          </Section>
        )}

        <Section title="About the poster">
          <TouchableOpacity activeOpacity={0.85} onPress={() => job.posterId && navigation.navigate('UserProfile', { userId: job.posterId })}>
            <PosterTrustCard poster={job.poster} />
          </TouchableOpacity>
          {!isOwnJob && (
            <TouchableOpacity style={styles.reportLink} onPress={handleReportGig}>
              <Ionicons name="flag-outline" size={13} color={colors.textMuted} style={{ marginRight: 5 }} />
              <Text style={styles.reportLinkText}>Report this gig</Text>
            </TouchableOpacity>
          )}
        </Section>

        {job.slots?.length > 0 && !alreadyBooked && !isOwnJob && (
          <Section title="Available times">
            <SlotPicker slots={job.slots} selected={selectedSlot} onSelect={setSelectedSlot} />
            {!selectedSlot && job.slots.some(s => !s.taken) && (
              <Text style={styles.slotHint}>Tap a time slot to select it</Text>
            )}
          </Section>
        )}

        {!alreadyBooked && !isOwnJob && (
          <Section title="Counter-offer (optional)">
            <View style={styles.counterCard}>
              <Text style={styles.counterInfo}>
                Listed rate: <Text style={styles.counterBold}>{estPay}</Text>
              </Text>
              <Text style={styles.counterHint}>Propose a different rate to negotiate before booking</Text>
              <View style={styles.counterInputRow}>
                <Text style={styles.counterDollar}>$</Text>
                <TextInput
                  style={styles.counterInput}
                  placeholder={String(job.pay)}
                  placeholderTextColor={colors.textMuted}
                  value={counterPrice}
                  onChangeText={setCounterPrice}
                  keyboardType="numeric"
                />
                <Text style={styles.counterUnit}>
                  {job.payType === 'hourly' ? '/ hr' : 'flat'}
                </Text>
              </View>
              {counterPrice !== '' && (
                <View style={styles.counterPreviewRow}>
                  <Text style={styles.counterPreview}>
                    Your offer: <Text style={styles.counterOfferValue}>${counterPrice}{job.payType === 'hourly' ? '/hr' : ''}</Text>
                    {'  '}vs listed ${job.pay}{job.payType === 'hourly' ? '/hr' : ''}
                  </Text>
                </View>
              )}
            </View>
          </Section>
        )}

        {!alreadyBooked && !isOwnJob && (
          <Section title="Add a note to the poster (optional)">
            <View style={styles.counterCard}>
              <Text style={styles.counterHint}>Tell the poster why you're a great fit</Text>
              <TextInput
                style={styles.noteInput}
                placeholder="Why you're a great fit…"
                placeholderTextColor={colors.textMuted}
                value={applicationNote}
                onChangeText={setApplicationNote}
                multiline
                maxLength={500}
                textAlignVertical="top"
              />
            </View>
          </Section>
        )}

        {!alreadyBooked && !isOwnJob && (
          <Section title="Payment">
            <View style={styles.feeCard}>
              {(() => {
                const baseRate = counterPrice ? (parseFloat(counterPrice) || job.pay) : job.pay;
                const gross = job.payType === 'hourly' ? baseRate * (job.estimatedHours || 1) : baseRate;
                const fee = gross * SERVICE_FEE_PCT;
                const net = gross - fee;
                return (
                  <>
                    <View style={styles.feeRow}>
                      <Text style={styles.feeLabel} numberOfLines={1}>Gig pay{job.payType === 'hourly' ? ' (est.)' : ''}</Text>
                      <Text style={styles.feeVal} numberOfLines={1}>${gross.toFixed(2)}</Text>
                    </View>
                    <View style={styles.feeRow}>
                      <Text style={styles.feeLabel} numberOfLines={2}>GoHustlr service fee ({Math.round(SERVICE_FEE_PCT * 100)}%)</Text>
                      <Text style={styles.feeVal} numberOfLines={1}>−${fee.toFixed(2)}</Text>
                    </View>
                    <View style={styles.feeDivider} />
                    <View style={styles.feeRow}>
                      <Text style={styles.feeTotalLabel} numberOfLines={1}>You receive</Text>
                      <Text style={styles.feeTotalVal} numberOfLines={1}>${net.toFixed(2)}</Text>
                    </View>
                    <Text style={styles.feeNote}>Paid securely in-app and released to you after the poster verifies your work. Tips (if any) are yours in full.</Text>
                  </>
                );
              })()}
            </View>
          </Section>
        )}

        {displayReviews.length > 0 && (
          <Section title={`Reviews (${displayReviews.length})`}>
            {displayReviews.map(r => (
              <View key={r.id} style={styles.reviewCard}>
                <View style={styles.reviewHeader}>
                  <Text style={styles.reviewAuthor} numberOfLines={1}>{r.author}</Text>
                  <RatingStars rating={r.rating} size={12} />
                  <Text style={styles.reviewDate} numberOfLines={1}>{r.date}</Text>
                </View>
                <Text style={styles.reviewText}>{r.text}</Text>
              </View>
            ))}
          </Section>
        )}
        <View style={{ height: (alreadyBooked || isOwnJob) ? 230 : 130 }} />
      </ScrollView>

      {/* The tab bar no longer reserves layout space (floating pill, hidden on
          detail screens), so the pinned footer must clear the home indicator /
          Android system nav itself. */}
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 20) + 12 }]}>
        {job.status === 'cancelled' ? (
          <View style={styles.ownJobBanner}>
            <Text style={styles.ownJobText} numberOfLines={2}>This listing has been removed</Text>
          </View>
        ) : isOwnJob ? (
          jobPosterBookings.length > 0 ? (
            <View>
              <View style={styles.ownJobStats}>
                <Text style={styles.ownJobStatTitle} numberOfLines={1}>
                  {jobPosterBookings.length} application{jobPosterBookings.length !== 1 ? 's' : ''} received
                </Text>
                <View style={styles.ownJobChips}>
                  {jobPosterBookings.filter(b => b.status === 'pending').length > 0 && (
                    <View style={styles.statChip}>
                      <Text style={styles.statChipText} numberOfLines={1}>
                        {jobPosterBookings.filter(b => b.status === 'pending').length} pending
                      </Text>
                    </View>
                  )}
                  {jobPosterBookings.filter(b => b.status === 'confirmed').length > 0 && (
                    <View style={[styles.statChip, styles.statChipGreen]}>
                      <Text style={[styles.statChipText, { color: colors.success }]} numberOfLines={1}>
                        {jobPosterBookings.filter(b => b.status === 'confirmed').length} confirmed
                      </Text>
                    </View>
                  )}
                </View>
              </View>
              <TouchableOpacity style={styles.manageGigsBtn} onPress={() => navigation.navigate('GigsTab')}>
                <Text style={styles.manageGigsBtnText} numberOfLines={1}>Manage applications in Gigs →</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.ownJobBanner}>
              <Text style={styles.ownJobText} numberOfLines={2}>Your gig — awaiting applications</Text>
            </View>
          )
        ) : alreadyBooked ? (
          <View>
            <View style={[styles.statusBanner, { backgroundColor: statusContent.bg }]}>
              <Ionicons name={statusContent.ion} size={22} color={statusContent.color} style={{ marginRight: 10 }} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.statusBannerTitle, { color: statusContent.color }]} numberOfLines={1}>
                  {statusContent.title}
                </Text>
                <Text style={styles.statusBannerDesc}>{statusContent.desc}</Text>
              </View>
            </View>
            {(canMessage || currentBooking?.status === 'verified') && (
              <View style={styles.statusActions}>
                {canMessage && (
                  <TouchableOpacity style={styles.msgActionBtn} onPress={() => setMsgVisible(true)}>
                    <Text style={styles.msgActionBtnText} numberOfLines={1}>Message poster</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={[styles.earnActionBtn, canMessage && styles.earnActionBtnSmall]}
                  onPress={() => navigation.navigate('EarnTab')}
                >
                  <Text style={styles.earnActionBtnText} numberOfLines={1}>Earn tab →</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        ) : (
          <TouchableOpacity style={styles.bookBtn} onPress={handleBook} activeOpacity={0.85}>
            <Text style={styles.bookBtnText} numberOfLines={1}>
              {selectedSlot
                ? (counterPrice ? `Book · Counter $${counterPrice}` : 'Book this gig')
                : job.slots?.some(s => !s.taken)
                  ? 'Select a time slot first'
                  : 'Book this gig'
              }
            </Text>
          </TouchableOpacity>
        )}
      </View>
      <MessageSheet
        visible={msgVisible}
        bookingId={currentBooking?.id}
        jobTitle={job.title}
        otherPerson={{ id: job.posterId, name: job.poster?.name, avatarInitial: job.poster?.avatarInitial, avatarUrl: job.poster?.avatarUrl }}
        onClose={() => setMsgVisible(false)}
      />

      <Modal visible={reportOpen} transparent animationType="fade" onRequestClose={() => setReportOpen(false)}>
        <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={() => setReportOpen(false)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Report this gig</Text>
            {REPORT_REASONS.map((r) => (
              <TouchableOpacity key={r} style={styles.sheetItem} onPress={() => doReportGig(r)}>
                <Text style={styles.sheetText} numberOfLines={2}>{r}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

function Section({ title, children }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  // Report reason sheet
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    paddingHorizontal: 20, paddingTop: 20, paddingBottom: 32,
  },
  // Matches the report sheet in MessageSheet so both report flows read identically.
  sheetTitle: {
    fontSize: 20, fontWeight: '700', color: colors.textPrimary,
    letterSpacing: -0.3, marginBottom: 8,
  },
  sheetItem: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.divider,
  },
  sheetText: { fontSize: 15, fontWeight: '500', color: colors.textPrimary, lineHeight: 20, flexShrink: 1 },

  container: { flex: 1, backgroundColor: colors.background },
  scroll: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 20 },

  urgentBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.urgentLight, borderRadius: radii.md,
    paddingVertical: 10, paddingHorizontal: 12, marginBottom: 16,
  },
  urgentText: { color: colors.urgent, fontWeight: '600', fontSize: 13, flexShrink: 1 },

  catRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  catText: { fontSize: 13, fontWeight: '500', color: colors.textMuted, flexShrink: 1, marginRight: 12 },
  saveBtn: {
    borderRadius: radii.pill, padding: 8, flexShrink: 0,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },

  title: {
    fontSize: 24, fontWeight: '700', color: colors.textPrimary,
    lineHeight: 31, letterSpacing: -0.4, marginBottom: 16,
  },

  gallery: { marginBottom: 20 },
  galleryImg: { width: 260, height: 180, borderRadius: radii.lg, marginRight: 10, backgroundColor: colors.divider },

  pillRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  payPill: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
    backgroundColor: colors.accentLight, borderRadius: radii.pill,
    paddingHorizontal: 12, paddingVertical: 8, marginRight: 8, marginBottom: 8,
    maxWidth: '100%',
  },
  payText: { fontSize: 13, fontWeight: '600', color: colors.accentDeep, flexShrink: 1 },
  locPill: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
    backgroundColor: colors.surface, borderRadius: radii.pill,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 8, marginRight: 8, marginBottom: 8,
    maxWidth: '100%',
  },
  locText: { fontSize: 13, fontWeight: '500', color: colors.textSecondary, flexShrink: 1 },
  recurPill: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
    backgroundColor: colors.surface, borderRadius: radii.pill,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 8, marginRight: 8, marginBottom: 8,
    maxWidth: '100%',
  },
  recurPillText: { fontSize: 13, fontWeight: '500', color: colors.textSecondary, flexShrink: 1 },

  addressHint: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 4, marginBottom: 16 },
  addressHintText: { fontSize: 12, color: colors.textMuted, flex: 1, lineHeight: 17 },

  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 12 },
  description: { fontSize: 15, color: colors.textSecondary, lineHeight: 23 },

  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  tagChip: {
    alignSelf: 'flex-start', backgroundColor: colors.surface,
    borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 10, paddingVertical: 5,
  },
  tagText: { fontSize: 12, fontWeight: '500', color: colors.textSecondary },

  hazardCard: {
    backgroundColor: colors.urgentLight, borderRadius: radii.lg,
    padding: 16, marginBottom: 24,
  },
  hazardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  hazardTitle: { fontSize: 14, fontWeight: '700', color: colors.urgent, flexShrink: 1 },
  hazardRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 6 },
  hazardText: { flex: 1, fontSize: 14, color: colors.textPrimary, lineHeight: 20, fontWeight: '400' },

  feeCard: {
    backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16,
    ...shadows.card,
  },
  feeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  feeLabel: { fontSize: 14, color: colors.textSecondary, flexShrink: 1, marginRight: 12 },
  feeVal: { fontSize: 14, color: colors.textPrimary, fontWeight: '500', flexShrink: 0 },
  feeDivider: { height: 1, backgroundColor: colors.divider, marginVertical: 8 },
  feeTotalLabel: { fontSize: 15, fontWeight: '600', color: colors.textPrimary, flexShrink: 1, marginRight: 12 },
  // Money reads as ink + weight (the JobCard/HomeScreen convention). Green is
  // reserved for "confirmed/paid/verified" — this figure is an estimate, not a payout.
  feeTotalVal: { fontSize: 16, fontWeight: '700', color: colors.textPrimary, flexShrink: 0 },
  feeNote: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: 12 },

  reportLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, marginTop: 8 },
  reportLinkText: { fontSize: 13, color: colors.textMuted, fontWeight: '500', flexShrink: 1 },

  reqRow: { flexDirection: 'row', marginBottom: 8 },
  reqDot: { fontSize: 14, color: colors.textMuted, marginRight: 8, marginTop: 1, lineHeight: 21 },
  reqText: { fontSize: 14, color: colors.textSecondary, flex: 1, lineHeight: 21 },
  slotHint: { fontSize: 12, color: colors.textMuted, marginTop: 12, textAlign: 'center' },

  counterCard: {
    backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16,
    ...shadows.card,
  },
  counterInfo: { fontSize: 14, color: colors.textSecondary, marginBottom: 4, lineHeight: 20 },
  counterBold: { fontWeight: '600', color: colors.textPrimary },
  counterHint: { fontSize: 12, color: colors.textMuted, marginBottom: 12, lineHeight: 18 },
  noteInput: {
    minHeight: 88, backgroundColor: colors.background, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border, padding: 12,
    fontSize: 15, color: colors.textPrimary, lineHeight: 21,
  },
  counterInputRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.background, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  counterDollar: { fontSize: 18, fontWeight: '600', color: colors.textMuted, marginRight: 6 },
  counterInput: { flex: 1, fontSize: 20, fontWeight: '600', color: colors.textPrimary, padding: 0 },
  counterUnit: { fontSize: 14, color: colors.textMuted, fontWeight: '500', marginLeft: 8, flexShrink: 0 },
  counterPreviewRow: {
    marginTop: 12, backgroundColor: colors.background,
    borderRadius: radii.md, padding: 12,
  },
  counterPreview: { fontSize: 13, color: colors.textSecondary, textAlign: 'center', lineHeight: 19 },
  counterOfferValue: { fontWeight: '700', color: colors.textPrimary },

  reviewCard: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    padding: 16, marginBottom: 12,
    ...shadows.card,
  },
  reviewHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  reviewAuthor: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, marginRight: 8, flexShrink: 1 },
  reviewDate: { fontSize: 11, color: colors.textMuted, marginLeft: 8, flexShrink: 0 },
  reviewText: { fontSize: 13, color: colors.textSecondary, lineHeight: 20 },

  footer: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: colors.surface, padding: 20,
    borderTopWidth: 1, borderTopColor: colors.divider,
  },
  bookBtn: {
    backgroundColor: colors.primary, borderRadius: radii.md,
    paddingVertical: 16, paddingHorizontal: 20, alignItems: 'center',
  },
  bookBtnText: { color: '#fff', fontSize: 16, fontWeight: '700', flexShrink: 1 },
  ownJobBanner: {
    backgroundColor: colors.background, borderRadius: radii.md,
    paddingVertical: 16, paddingHorizontal: 20, alignItems: 'center',
  },
  ownJobText: { color: colors.textSecondary, fontSize: 14, fontWeight: '500', textAlign: 'center', flexShrink: 1 },

  // Status-aware footer for earner
  statusBanner: {
    flexDirection: 'row', alignItems: 'flex-start',
    borderRadius: radii.lg, padding: 14, marginBottom: 12,
  },
  statusBannerTitle: { fontSize: 14, fontWeight: '700', marginBottom: 4 },
  statusBannerDesc: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  statusActions: { flexDirection: 'row', gap: 10 },
  msgActionBtn: {
    flex: 1, backgroundColor: colors.surface, borderRadius: radii.md,
    paddingVertical: 12, paddingHorizontal: 12, alignItems: 'center',
    borderWidth: 1, borderColor: colors.border,
  },
  msgActionBtnText: { color: colors.textPrimary, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  earnActionBtn: {
    flex: 1, backgroundColor: colors.primary,
    borderRadius: radii.md, paddingVertical: 12, paddingHorizontal: 12, alignItems: 'center',
  },
  earnActionBtnSmall: { flex: 0.85 },
  earnActionBtnText: { color: '#fff', fontSize: 13, fontWeight: '600', flexShrink: 1 },

  // Poster own-job footer
  ownJobStats: {
    backgroundColor: colors.background, borderRadius: radii.lg,
    padding: 14, marginBottom: 12,
  },
  ownJobStatTitle: { fontSize: 14, fontWeight: '600', color: colors.textPrimary, marginBottom: 8 },
  ownJobChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  statChip: {
    alignSelf: 'flex-start', backgroundColor: colors.accentLight,
    borderRadius: radii.pill, paddingHorizontal: 12, paddingVertical: 5,
  },
  statChipGreen: { backgroundColor: colors.successLight },
  statChipText: { fontSize: 12, fontWeight: '600', color: colors.accentDeep },
  manageGigsBtn: {
    backgroundColor: colors.primary, borderRadius: radii.md,
    paddingVertical: 14, paddingHorizontal: 20, alignItems: 'center',
  },
  manageGigsBtnText: { color: '#fff', fontSize: 14, fontWeight: '600', flexShrink: 1 },
});
