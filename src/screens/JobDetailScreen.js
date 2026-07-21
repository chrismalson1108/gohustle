import React, { useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, TextInput, Image, Modal, ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
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
import { colors, shadows } from '../theme';
import { CATEGORY_COLORS } from '../data/mockData';
import MessageSheet from '../components/MessageSheet';
import { submitReport, REPORT_REASONS } from '../lib/moderation';
import { findProhibited } from '../lib/contentFilter';
import { logModerationBlock } from '../lib/moderation';
import { SERVICE_FEE_PCT } from '../lib/stripeClient';

const STATUS_CONTENT = {
  pending:   { ion: 'time', title: 'Application Pending',
               desc: "The poster hasn't reviewed your booking yet. Hang tight!",
               bg: '#FFF7ED', color: '#D97706' },
  confirmed: { ion: 'checkmark-circle', title: "Confirmed — You're In!",
               desc: 'Accepted! Head to the Earn tab to mark done when finished.',
               bg: '#ECFDF5', color: '#059669' },
  completed: { ion: 'sync', title: 'Awaiting Verification',
               desc: 'You marked done. The poster needs to verify your work.',
               bg: '#EFF6FF', color: '#2563EB' },
  verified:  { ion: 'shield-checkmark', title: 'Completed & Verified',
               desc: 'All done! Go to the Earn tab to rate the poster.',
               bg: '#F0FDF4', color: '#16A34A' },
  declined:  { ion: 'close-circle', title: 'Application Declined',
               desc: "The poster didn't accept your booking.",
               bg: '#FEF2F2', color: '#DC2626' },
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
  const displayLocation = showExactAddress ? job.location : maskLocation(job.location);
  const addressMasked = !showExactAddress && displayLocation !== job.location;

  // Prefer reviews loaded on demand; fall back to whatever came with the job (the
  // fetchJobById path still embeds them) until the direct load resolves.
  const displayReviews = jobReviews ?? job.reviews ?? [];

  const catColor = CATEGORY_COLORS[job.category] || colors.primary;
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
          <View style={[styles.urgentBanner, { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }]}>
            <Ionicons name="flash" size={14} color={colors.urgent} style={{ marginRight: 6 }} />
            <Text style={styles.urgentText}>URGENT — Needed ASAP</Text>
          </View>
        )}

        <View style={styles.catRow}>
          <View style={[styles.catBadge, { backgroundColor: catColor + '22' }]}>
            <Text style={[styles.catText, { color: catColor }]}>{job.category}</Text>
          </View>
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
          <LinearGradient colors={['#ECFDF5', '#D1FAE5']} style={[styles.payPill, { flexDirection: 'row', alignItems: 'center' }]}>
            <Ionicons name="cash" size={14} color={colors.success} style={{ marginRight: 5 }} />
            <Text style={styles.payText}>{estPay}</Text>
          </LinearGradient>
          <View style={[styles.locPill, { flexDirection: 'row', alignItems: 'center' }]}>
            <Ionicons name="location" size={13} color={colors.textSecondary} style={{ marginRight: 4 }} />
            <Text style={styles.locText}>{displayLocation}</Text>
          </View>
          {RECUR_LABEL[job.recurrence] && (
            <View style={[styles.recurPill, { flexDirection: 'row', alignItems: 'center' }]}>
              <Ionicons name="repeat" size={13} color={colors.primary} style={{ marginRight: 4 }} />
              <Text style={styles.recurPillText}>Repeats {RECUR_LABEL[job.recurrence]}</Text>
            </View>
          )}
        </View>

        {addressMasked && (
          <View style={styles.addressHint}>
            <Ionicons name="lock-closed-outline" size={13} color={colors.textMuted} style={{ marginRight: 6 }} />
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
              <Text style={styles.hazardTitle}>Safety notes</Text>
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

        <Section title="About the Poster">
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
          <Section title="Available Times">
            <SlotPicker slots={job.slots} selected={selectedSlot} onSelect={setSelectedSlot} />
            {!selectedSlot && job.slots.some(s => !s.taken) && (
              <Text style={styles.slotHint}>Tap a time slot to select it</Text>
            )}
          </Section>
        )}

        {!alreadyBooked && !isOwnJob && (
          <Section title="Counter-offer (Optional)">
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
                      <Text style={styles.feeLabel}>Gig pay{job.payType === 'hourly' ? ' (est.)' : ''}</Text>
                      <Text style={styles.feeVal}>${gross.toFixed(2)}</Text>
                    </View>
                    <View style={styles.feeRow}>
                      <Text style={styles.feeLabel}>GoHustlr service fee ({Math.round(SERVICE_FEE_PCT * 100)}%)</Text>
                      <Text style={styles.feeVal}>−${fee.toFixed(2)}</Text>
                    </View>
                    <View style={styles.feeDivider} />
                    <View style={styles.feeRow}>
                      <Text style={styles.feeTotalLabel}>You receive</Text>
                      <Text style={styles.feeTotalVal}>${net.toFixed(2)}</Text>
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
                  <Text style={styles.reviewAuthor}>{r.author}</Text>
                  <RatingStars rating={r.rating} size={12} />
                  <Text style={styles.reviewDate}>{r.date}</Text>
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
            <Text style={styles.ownJobText}>This listing has been removed</Text>
          </View>
        ) : isOwnJob ? (
          jobPosterBookings.length > 0 ? (
            <View>
              <View style={styles.ownJobStats}>
                <Text style={styles.ownJobStatTitle}>
                  {jobPosterBookings.length} application{jobPosterBookings.length !== 1 ? 's' : ''} received
                </Text>
                <View style={styles.ownJobChips}>
                  {jobPosterBookings.filter(b => b.status === 'pending').length > 0 && (
                    <View style={styles.statChip}>
                      <Text style={styles.statChipText}>
                        {jobPosterBookings.filter(b => b.status === 'pending').length} pending
                      </Text>
                    </View>
                  )}
                  {jobPosterBookings.filter(b => b.status === 'confirmed').length > 0 && (
                    <View style={[styles.statChip, styles.statChipGreen]}>
                      <Text style={[styles.statChipText, { color: '#059669' }]}>
                        {jobPosterBookings.filter(b => b.status === 'confirmed').length} confirmed
                      </Text>
                    </View>
                  )}
                </View>
              </View>
              <TouchableOpacity style={styles.manageGigsBtn} onPress={() => navigation.navigate('GigsTab')}>
                <Text style={styles.manageGigsBtnText}>Manage Applications in Gigs →</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.ownJobBanner}>
              <Text style={styles.ownJobText}>Your gig — awaiting applications</Text>
            </View>
          )
        ) : alreadyBooked ? (
          <View>
            <View style={[styles.statusBanner, { backgroundColor: statusContent.bg }]}>
              <Ionicons name={statusContent.ion} size={22} color={statusContent.color} style={{ marginRight: 10 }} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.statusBannerTitle, { color: statusContent.color }]}>
                  {statusContent.title}
                </Text>
                <Text style={styles.statusBannerDesc}>{statusContent.desc}</Text>
              </View>
            </View>
            {(canMessage || currentBooking?.status === 'verified') && (
              <View style={styles.statusActions}>
                {canMessage && (
                  <TouchableOpacity style={styles.msgActionBtn} onPress={() => setMsgVisible(true)}>
                    <Text style={styles.msgActionBtnText}>Message Poster</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={[styles.earnActionBtn, canMessage && styles.earnActionBtnSmall]}
                  onPress={() => navigation.navigate('EarnTab')}
                >
                  <Text style={styles.earnActionBtnText}>Earn Tab →</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        ) : (
          <TouchableOpacity onPress={handleBook} activeOpacity={0.85}>
            <LinearGradient colors={[colors.primary, colors.secondary]} style={styles.bookBtn}>
              <Text style={styles.bookBtnText}>
                {selectedSlot
                  ? (counterPrice ? `Book · Counter $${counterPrice}` : 'Book This Gig')
                  : job.slots?.some(s => !s.taken)
                    ? 'Select a Time Slot First'
                    : 'Book This Gig'
                }
              </Text>
            </LinearGradient>
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
                <Text style={styles.sheetText}>{r}</Text>
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
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 12, paddingBottom: 28 },
  sheetTitle: { fontSize: 13, fontWeight: '800', color: colors.textMuted, padding: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  sheetItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 12, borderRadius: 12 },
  sheetText: { fontSize: 15.5, fontWeight: '700', color: colors.textPrimary },
  container: { flex: 1, backgroundColor: '#fff' },
  scroll: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 20 },
  urgentBanner: {
    backgroundColor: colors.urgentLight, borderRadius: 10,
    padding: 10, marginBottom: 16, alignItems: 'center',
  },
  urgentText: { color: colors.urgent, fontWeight: '800', fontSize: 13 },
  catRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  catBadge: {
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  saveBtn: {
    borderRadius: 18, padding: 7,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  catText: { fontSize: 12, fontWeight: '700' },
  title: { fontSize: 22, fontWeight: '900', color: colors.textPrimary, lineHeight: 30, marginBottom: 16 },
  gallery: { marginBottom: 20 },
  galleryImg: { width: 260, height: 180, borderRadius: 16, marginRight: 10, backgroundColor: colors.border },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  payPill: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, marginRight: 10, marginBottom: 10 },
  payText: { fontSize: 13, fontWeight: '700', color: colors.success },
  locPill: {
    backgroundColor: colors.background, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 9, marginBottom: 10,
  },
  locText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  addressHint: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, marginTop: 8 },
  addressHintText: { fontSize: 12, color: colors.textMuted, flex: 1 },
  recurPill: {
    backgroundColor: colors.primary + '14', borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 9, marginLeft: 10, marginBottom: 10,
  },
  recurPillText: { fontSize: 13, fontWeight: '700', color: colors.primary },
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 12, fontWeight: '800', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 12,
  },
  description: { fontSize: 15, color: colors.textPrimary, lineHeight: 24 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  tagChip: { backgroundColor: colors.background, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 4, borderWidth: 1, borderColor: colors.border },
  tagText: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  hazardCard: {
    backgroundColor: colors.urgentLight, borderRadius: 16, padding: 16, marginBottom: 24,
    borderWidth: 1.5, borderColor: colors.urgent,
  },
  hazardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  hazardTitle: {
    fontSize: 13, fontWeight: '800', color: colors.urgent,
    textTransform: 'uppercase', letterSpacing: 0.6,
  },
  hazardRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  hazardText: { flex: 1, fontSize: 14, color: colors.textPrimary, lineHeight: 20, fontWeight: '600' },
  feeCard: { backgroundColor: colors.background, borderRadius: 16, padding: 16, borderWidth: 1.5, borderColor: colors.border },
  feeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5 },
  feeLabel: { fontSize: 14, color: colors.textSecondary },
  feeVal: { fontSize: 14, color: colors.textPrimary, fontWeight: '600' },
  feeDivider: { height: 1, backgroundColor: colors.border, marginVertical: 8 },
  feeTotalLabel: { fontSize: 15, fontWeight: '800', color: colors.textPrimary },
  feeTotalVal: { fontSize: 16, fontWeight: '900', color: colors.success },
  feeNote: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: 10 },
  reportLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, marginTop: 4 },
  reportLinkText: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
  reqRow: { flexDirection: 'row', marginBottom: 6 },
  reqDot: { fontSize: 14, color: colors.primary, marginRight: 8, marginTop: 1 },
  reqText: { fontSize: 14, color: colors.textPrimary, flex: 1, lineHeight: 21 },
  slotHint: { fontSize: 12, color: colors.textMuted, marginTop: 8, textAlign: 'center', fontStyle: 'italic' },
  counterCard: {
    backgroundColor: colors.background, borderRadius: 16,
    padding: 16, borderWidth: 1.5, borderColor: colors.border,
  },
  counterInfo: { fontSize: 14, color: colors.textSecondary, marginBottom: 4 },
  counterBold: { fontWeight: '700', color: colors.textPrimary },
  counterHint: { fontSize: 12, color: colors.textMuted, marginBottom: 14, lineHeight: 18 },
  noteInput: {
    minHeight: 80, backgroundColor: colors.surface, borderRadius: 12,
    borderWidth: 1.5, borderColor: colors.border, padding: 12,
    fontSize: 15, color: colors.textPrimary, lineHeight: 20,
  },
  counterInputRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: 12,
    borderWidth: 1.5, borderColor: colors.border,
    paddingHorizontal: 14, height: 48,
  },
  counterDollar: { fontSize: 18, fontWeight: '700', color: colors.primary, marginRight: 6 },
  counterInput: { flex: 1, fontSize: 20, fontWeight: '700', color: colors.textPrimary },
  counterUnit: { fontSize: 14, color: colors.textMuted, fontWeight: '600' },
  counterPreviewRow: {
    marginTop: 10, backgroundColor: colors.primaryLight,
    borderRadius: 10, padding: 10,
  },
  counterPreview: { fontSize: 13, color: colors.textSecondary, textAlign: 'center' },
  counterOfferValue: { fontWeight: '800', color: colors.primary },
  reviewCard: {
    backgroundColor: colors.background, borderRadius: 14,
    padding: 14, marginBottom: 10,
  },
  reviewHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  reviewAuthor: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, marginRight: 8 },
  reviewDate: { fontSize: 11, color: colors.textMuted, marginLeft: 8 },
  reviewText: { fontSize: 13, color: colors.textSecondary, lineHeight: 20 },
  footer: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: '#fff', padding: 20,
    borderTopWidth: 1, borderTopColor: colors.border,
    ...shadows.md,
  },
  bookBtn: { borderRadius: 16, paddingVertical: 17, alignItems: 'center' },
  bookBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  bookedBtn: {
    backgroundColor: colors.successLight, borderRadius: 16,
    paddingVertical: 17, alignItems: 'center',
  },
  bookedText: { color: colors.success, fontSize: 16, fontWeight: '800' },
  ownJobBanner: {
    backgroundColor: colors.primaryLight, borderRadius: 16,
    paddingVertical: 17, alignItems: 'center',
    borderWidth: 1.5, borderColor: colors.primary + '40',
  },
  ownJobText: { color: colors.primary, fontSize: 14, fontWeight: '700', textAlign: 'center' },
  // Status-aware footer for earner
  statusBanner: {
    flexDirection: 'row', alignItems: 'flex-start',
    borderRadius: 14, padding: 14, marginBottom: 10,
  },
  statusBannerIcon: { fontSize: 22, marginRight: 12, marginTop: 1 },
  statusBannerTitle: { fontSize: 14, fontWeight: '800', marginBottom: 3 },
  statusBannerDesc: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  statusActions: { flexDirection: 'row', gap: 10 },
  msgActionBtn: {
    flex: 1, backgroundColor: colors.primaryLight, borderRadius: 12,
    paddingVertical: 12, alignItems: 'center',
    borderWidth: 1.5, borderColor: colors.primary + '40',
  },
  msgActionBtnText: { color: colors.primary, fontSize: 13, fontWeight: '700' },
  earnActionBtn: {
    flex: 1, backgroundColor: colors.primary,
    borderRadius: 12, paddingVertical: 12, alignItems: 'center',
  },
  earnActionBtnSmall: { flex: 0.55 },
  earnActionBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  // Poster own-job footer
  ownJobStats: {
    backgroundColor: colors.primaryLight, borderRadius: 14,
    padding: 14, marginBottom: 10,
    borderWidth: 1.5, borderColor: colors.primary + '40',
  },
  ownJobStatTitle: { fontSize: 14, fontWeight: '800', color: colors.primary, marginBottom: 8 },
  ownJobChips: { flexDirection: 'row', gap: 8 },
  statChip: {
    backgroundColor: '#FFF7ED', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  statChipGreen: { backgroundColor: '#ECFDF5' },
  statChipText: { fontSize: 12, fontWeight: '700', color: '#D97706' },
  manageGigsBtn: {
    backgroundColor: colors.primary, borderRadius: 12,
    paddingVertical: 12, alignItems: 'center',
  },
  manageGigsBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
