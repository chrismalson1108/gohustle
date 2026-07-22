import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity, Modal, Image, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import { useHaptic } from '../hooks/useHaptic';
import { isFavorite, addFavorite, removeFavorite } from '../lib/favorites';
import { fetchCertifications, safeCertUrl } from '../lib/certifications';
import { computeCertifications } from '../lib/insights';
import { submitReport, REPORT_REASONS } from '../lib/moderation';
import { notify } from '../lib/push';
import ScreenHeader from '../components/ScreenHeader';
import Avatar from '../components/Avatar';
import MessageSheet from '../components/MessageSheet';
import RatingStars from '../components/RatingStars';
import { collegeLine } from '../lib/school';
import { DAYS, windowsForDay, fmtTime, workStatusMeta } from '../lib/availability';
import { maskLocation } from '../lib/address';
import { colors, radii, shadows } from '../theme';

const avg = (arr) => arr.length ? (arr.reduce((s, r) => s + Number(r.rating || 0), 0) / arr.length) : null;

export default function PublicProfileScreen({ route, navigation }) {
  const { userId } = route.params;
  const { user } = useAuth();
  const { name: myName, showToast } = useUser();
  const { postedJobs, blockUser, jobs, bookings, posterBookings } = useJobs();
  const haptic = useHaptic();
  const isSelf = user?.id === userId;
  const [msgOpen, setMsgOpen] = useState(false);
  const [profile, setProfile] = useState(null);
  const [availability, setAvailabilityState] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [listings, setListings] = useState([]);
  const [certs, setCerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fav, setFav] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const myOpenGigs = (postedJobs || []).filter(j => j.status === 'open');

  // Messaging is booking-scoped (party-scoped RLS on messages), so this person
  // is messageable iff a booking connects us: me as the earner on their job, or
  // them as the earner on mine. Prefer an in-flight booking; both source arrays
  // are already newest-first.
  const ACTIVE_MSG_STATUSES = ['pending', 'confirmed', 'completed'];
  const sharedBookings = [
    ...(bookings || [])
      .filter(b => (jobs || []).find(j => j.id === b.jobId)?.posterId === userId)
      .map(b => ({ booking: b, jobTitle: (jobs || []).find(j => j.id === b.jobId)?.title || b.job?.title || '' })),
    ...(posterBookings || [])
      .filter(b => b.earner?.id === userId)
      .map(b => ({ booking: b, jobTitle: b.job?.title || '' })),
  ];
  const sharedBooking = sharedBookings.find(s => ACTIVE_MSG_STATUSES.includes(s.booking.status)) || sharedBookings[0] || null;

  const sendInvite = async (job) => {
    haptic.success();
    setInviteOpen(false);
    // send-push only delivers to someone we already share a booking with; an invite to
    // a brand-new person is silently dropped (403) with no push and no in-app row. Don't
    // claim "Invitation sent" when it can't be delivered — mirror the server gate (any
    // shared booking) and gate success on the real send result. (notify() is best-effort
    // and returns undefined today; once it reports success/failure this tightens further.)
    const canDeliver = sharedBookings.length > 0;
    const ok = canDeliver
      ? await notify(userId, 'You got a gig invitation', `${myName || 'Someone'} invited you to apply to "${job.title}"`, { tab: 'HomeTab' })
      : false;
    if (ok === false) {
      haptic.error();
      showToast({ icon: '⚠️', title: "Couldn't send invite", message: 'You can only invite someone you already share a booking with. Message them to connect first.' });
      return;
    }
    showToast({ icon: '✅', title: 'Invitation sent', message: `${profile?.name || 'They'} were invited to "${job.title}".` });
  };

  const toggleFav = async () => {
    if (!user || isSelf) return;
    haptic.light();
    try {
      if (fav) { await removeFavorite(user.id, userId); setFav(false); }
      else { await addFavorite(user.id, userId); setFav(true); }
    } catch (_) {}
  };

  const doBlock = async () => {
    setMenuOpen(false);
    try {
      await blockUser(userId);
      showToast({ icon: '🚫', title: 'User blocked', message: "You won't see their gigs anymore." });
      navigation.goBack();
    } catch (_) {
      showToast({ icon: '⚠️', title: "Couldn't block", message: 'Please try again.' });
    }
  };

  const doReport = async (reason) => {
    setReportOpen(false);
    try {
      await submitReport({ reporterId: user.id, reportedUserId: userId, reason });
      showToast({ icon: '🚩', title: 'Report submitted', message: 'Thanks — our team will review it.' });
    } catch (_) {
      showToast({ icon: '⚠️', title: "Couldn't submit", message: 'Please try again.' });
    }
  };

  const load = useCallback(async () => {
    if (user && !isSelf) isFavorite(user.id, userId).then(setFav).catch(() => {});
    const [{ data: prof }, { data: revs }, { data: jobs }, certRows] = await Promise.all([
      supabase.from('profiles')
        .select('id, name, avatar_initial, avatar_url, city, bio, skills, skill_rates, rating, review_count, member_since, verified, created_at, school, major, grad_year, student_verified, student_status, work_status')
        .eq('id', userId).single(),
      supabase.from('reviews')
        .select('id, rating, text, date, role, job:jobs(title, category, tags), reviewer:profiles!reviewer_id(id, name, avatar_initial, avatar_url)')
        .eq('reviewed_user_id', userId).order('created_at', { ascending: false }),
      supabase.from('jobs')
        .select('id, title, category, pay, pay_type, location, status')
        .eq('poster_id', userId).eq('status', 'open').order('created_at', { ascending: false }),
      fetchCertifications(userId).catch(() => []),
    ]);
    setProfile(prof || null);
    setReviews(revs || []);
    setListings(jobs || []);
    setCerts(certRows || []);
    setLoading(false);

    // Availability is private by default. It's served through the SECURITY DEFINER
    // RPC profile_availability(), which returns windows ONLY when the owner opted in
    // (show_availability) or the viewer is the owner — the opt-out is enforced in the
    // DB, not just here. The raw column is revoked, so anon/non-opted-in reads return
    // nothing. Only call it for signed-in viewers (the RPC is execute-granted to them).
    if (user) {
      try {
        const { data: avail } = await supabase.rpc('profile_availability', { uid: userId });
        setAvailabilityState(Array.isArray(avail) ? avail : []);
      } catch (_) { /* degrade gracefully — just no availability shown */ }
    }
  }, [userId, user]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>;
  }
  if (!profile) {
    return <View style={styles.center}><Text style={styles.muted}>This profile is unavailable.</Text></View>;
  }

  const workerReviews = reviews.filter(r => r.role === 'earner');
  const clientReviews = reviews.filter(r => r.role === 'poster');
  const { certified, progress } = computeCertifications(workerReviews);
  const overall = avg(reviews);
  const workerAvg = avg(workerReviews);
  const clientAvg = avg(clientReviews);

  const availDays = DAYS
    .map((label, day) => ({ label, day, windows: windowsForDay(availability, day) }))
    .filter((d) => d.windows.length > 0);
  // Show availability only when the gated RPC returned windows (it already enforces
  // opted-in-or-owner server-side), so any non-empty result is safe to display.
  const canShowAvailability = !!user && availDays.length > 0;

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      <ScreenHeader underNav>
        <View style={styles.headerRow}>
          <Avatar url={profile.avatar_url} initial={profile.avatar_initial || profile.name?.[0]} size={64} fontSize={26}
            style={{ marginRight: 16 }} />
          <View style={styles.headerInfo}>
            <View style={styles.nameRow}>
              <Text style={styles.name} numberOfLines={2}>{profile.name || 'GoHustlr user'}</Text>
              {profile.verified && <Ionicons name="checkmark-circle" size={16} color={colors.success} style={styles.nameIcon} />}
              {profile.student_verified && <Ionicons name="school" size={14} color={colors.textSecondary} style={styles.nameIcon} />}
            </View>
            {overall != null
              ? <RatingStars rating={overall} size={14} />
              : <Text style={styles.subMeta} numberOfLines={1}>No reviews yet</Text>}
            <Text style={styles.subMeta} numberOfLines={1}>
              {reviews.length > 0 ? `${overall.toFixed(1)} · ${reviews.length} review${reviews.length !== 1 ? 's' : ''}` : ''}
              {profile.member_since ? `${reviews.length ? ' · ' : ''}Since ${profile.member_since}` : ''}
            </Text>
            {!!collegeLine(profile) && <Text style={styles.subMeta} numberOfLines={1}>{collegeLine(profile)}</Text>}
            {profile.city ? <Text style={styles.subMeta} numberOfLines={1}>{profile.city}</Text> : null}
          </View>
          {!isSelf && user && (
            <View style={styles.headerActions}>
              <TouchableOpacity onPress={toggleFav} style={styles.favBtn} activeOpacity={0.8}>
                <Ionicons name={fav ? 'heart' : 'heart-outline'} size={20} color={fav ? colors.urgent : colors.textPrimary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setMenuOpen(true)} style={styles.favBtn} activeOpacity={0.8} accessibilityLabel="More options">
                <Ionicons name="ellipsis-horizontal" size={20} color={colors.textPrimary} />
              </TouchableOpacity>
            </View>
          )}
        </View>
      </ScreenHeader>

      {/* Report / block action sheet */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={() => setMenuOpen(false)}>
          <View style={styles.sheet}>
            <TouchableOpacity style={styles.sheetItem} onPress={() => { setMenuOpen(false); setReportOpen(true); }}>
              <Ionicons name="flag-outline" size={18} color={colors.textPrimary} style={{ marginRight: 10 }} />
              <Text style={styles.sheetText}>Report</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.sheetItem} onPress={doBlock}>
              <Ionicons name="ban-outline" size={18} color={colors.urgent} style={{ marginRight: 10 }} />
              <Text style={[styles.sheetText, { color: colors.urgent }]}>Block this user</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal visible={reportOpen} transparent animationType="fade" onRequestClose={() => setReportOpen(false)}>
        <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={() => setReportOpen(false)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Report {profile.name || 'this user'}</Text>
            {REPORT_REASONS.map((r) => (
              <TouchableOpacity key={r} style={styles.sheetItem} onPress={() => doReport(r)}>
                <Text style={styles.sheetText}>{r}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Rating breakdown */}
      <View style={styles.breakRow}>
        <View style={styles.breakItem}>
          <Ionicons name="briefcase-outline" size={16} color={colors.textSecondary} />
          <Text style={styles.breakVal} numberOfLines={1}>{workerAvg != null ? workerAvg.toFixed(1) : '—'}</Text>
          <Text style={styles.breakLabel} numberOfLines={1}>As a worker ({workerReviews.length})</Text>
        </View>
        <View style={styles.breakDivider} />
        <View style={styles.breakItem}>
          <Ionicons name="megaphone-outline" size={16} color={colors.textSecondary} />
          <Text style={styles.breakVal} numberOfLines={1}>{clientAvg != null ? clientAvg.toFixed(1) : '—'}</Text>
          <Text style={styles.breakLabel} numberOfLines={1}>As a client ({clientReviews.length})</Text>
        </View>
      </View>

      {isSelf && (
        <View style={styles.selfBanner}>
          <Ionicons name="eye-outline" size={15} color={colors.textMuted} style={{ marginRight: 8 }} />
          <Text style={styles.selfBannerText}>This is your public profile — exactly how others see you.</Text>
        </View>
      )}

      {canShowAvailability && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Availability</Text>
          <View style={styles.availCard}>
            {!!profile?.work_status && (() => {
              const ws = workStatusMeta(profile.work_status);
              return (
                <View style={styles.availStatusRow}>
                  <View style={[styles.availStatusDot, { backgroundColor: ws.color }]} />
                  <Text style={styles.availStatusLabel} numberOfLines={1}>{ws.label}</Text>
                </View>
              );
            })()}
            {availDays.map(({ label, day, windows }) => (
              <View key={day} style={styles.availRow}>
                <Text style={styles.availDay} numberOfLines={1}>{label}</Text>
                <Text style={styles.availTimes} numberOfLines={2}>
                  {windows.map((w) => `${fmtTime(w.start)}–${fmtTime(w.end)}`).join(', ')}
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {!isSelf && user && (sharedBooking || myOpenGigs.length > 0) && (
        <View style={styles.actionRow}>
          {sharedBooking && (
            <TouchableOpacity
              style={[styles.inviteBtn, styles.actionBtn, myOpenGigs.length > 0 && { marginRight: 8 }]}
              onPress={() => { haptic.light(); setMsgOpen(true); }}
              activeOpacity={0.85}
            >
              <Ionicons name="chatbubble-outline" size={16} color="#fff" style={{ marginRight: 6 }} />
              <Text style={styles.inviteBtnText} numberOfLines={1}>Message</Text>
            </TouchableOpacity>
          )}
          {myOpenGigs.length > 0 && (
            <TouchableOpacity
              style={[styles.inviteBtn, styles.actionBtn, sharedBooking && styles.actionBtnOutline]}
              onPress={() => setInviteOpen(true)}
              activeOpacity={0.85}
            >
              <Ionicons name="paper-plane-outline" size={16} color={sharedBooking ? colors.textPrimary : '#fff'} style={{ marginRight: 6 }} />
              <Text style={[styles.inviteBtnText, sharedBooking && styles.inviteBtnTextOutline]} numberOfLines={1}>Invite to a gig</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {profile.bio ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About</Text>
          <Text style={styles.bio}>{profile.bio}</Text>
        </View>
      ) : null}

      {profile.skills?.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Skills</Text>
          <View style={styles.chipWrap}>
            {profile.skills.map(s => (
              <View key={s} style={styles.skillChip}>
                <Text style={styles.skillText} numberOfLines={1}>{s}{profile.skill_rates?.[s] ? ` · $${profile.skill_rates[s]}/hr` : ''}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {certified.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Hustlr Certified</Text>
          <View style={styles.certWrap}>
            {certified.map(c => (
              <View key={c.label} style={styles.certifiedBadge}>
                <Ionicons name="shield-checkmark" size={18} color={colors.success} style={{ marginRight: 8 }} />
                <View style={styles.certifiedTextWrap}>
                  <Text style={styles.certifiedTitle} numberOfLines={1}>Certified · {c.label}</Text>
                  <Text style={styles.certifiedSub} numberOfLines={1}>{c.count} jobs</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      )}

      {isSelf && certified.length === 0 && progress.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Progress to certification</Text>
          <View style={styles.progressCard}>
            {progress.map(p => (
              <View key={p.label} style={styles.progressRow}>
                <Text style={styles.progressLabel} numberOfLines={1}>{p.label}</Text>
                <Text style={styles.progressCount} numberOfLines={1}>{p.count}/{p.needed}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {certs.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Certifications ({certs.length})</Text>
          {certs.map(c => {
            const certImg = safeCertUrl(c.image_url);
            return (
            <TouchableOpacity
              key={c.id}
              activeOpacity={certImg ? 0.8 : 1}
              disabled={!certImg}
              onPress={() => certImg && Linking.openURL(certImg)}
              style={styles.certCard}
            >
              {certImg ? (
                <Image source={{ uri: certImg }} style={styles.certThumb} />
              ) : (
                <View style={styles.certThumbPlaceholder}>
                  <Ionicons name="ribbon-outline" size={20} color={colors.textMuted} />
                </View>
              )}
              <View style={styles.rowGrow}>
                <Text style={styles.certTitle} numberOfLines={1}>{c.title}</Text>
                {(c.issuer || c.year) ? (
                  <Text style={styles.certMeta} numberOfLines={1}>{[c.issuer, c.year].filter(Boolean).join(' · ')}</Text>
                ) : null}
              </View>
              {certImg ? <Ionicons name="open-outline" size={16} color={colors.textMuted} style={styles.rowChevron} /> : null}
            </TouchableOpacity>
            );
          })}
        </View>
      )}

      {listings.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Open gigs they posted ({listings.length})</Text>
          {listings.map(j => (
            <TouchableOpacity key={j.id} style={styles.jobRow} onPress={() => navigation.navigate('JobDetail', { jobId: j.id })}>
              <View style={styles.rowGrow}>
                <Text style={styles.jobTitle} numberOfLines={1}>{j.title}</Text>
                <Text style={styles.jobMeta} numberOfLines={1}>
                  {j.pay_type === 'hourly' ? `$${j.pay}/hr` : `$${j.pay} flat`} · {j.category} · {maskLocation(j.location)}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} style={styles.rowChevron} />
            </TouchableOpacity>
          ))}
        </View>
      )}

      {workerReviews.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Recent work ({workerReviews.length})</Text>
          {workerReviews.slice(0, 10).map((r) => (
            <View key={r.id} style={styles.workCard}>
              <View style={styles.workTop}>
                <Text style={styles.workTitle} numberOfLines={1}>{r.job?.title || 'Completed gig'}</Text>
                <RatingStars rating={r.rating} size={13} />
              </View>
              {r.text ? <Text style={styles.workReview} numberOfLines={2}>{r.text}</Text> : null}
            </View>
          ))}
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Reviews ({reviews.length})</Text>
        {reviews.length === 0 ? (
          <Text style={styles.muted}>No reviews yet.</Text>
        ) : reviews.map(r => (
          <View key={r.id} style={styles.reviewCard}>
            <View style={styles.reviewHead}>
              <Avatar url={r.reviewer?.avatar_url} initial={r.reviewer?.avatar_initial || r.reviewer?.name?.[0]} size={32} fontSize={13} style={{ marginRight: 10 }} />
              <View style={styles.rowGrow}>
                <Text style={styles.reviewer} numberOfLines={1}>{r.reviewer?.name || 'User'}</Text>
                <View style={styles.reviewMetaRow}>
                  <RatingStars rating={r.rating} size={11} />
                  <View style={styles.roleTag}>
                    <Text style={styles.roleTagText} numberOfLines={1}>
                      {r.role === 'poster' ? 'as a client' : 'as a worker'}
                    </Text>
                  </View>
                </View>
              </View>
              {r.date ? <Text style={styles.reviewDate} numberOfLines={1}>{r.date}</Text> : null}
            </View>
            {r.text ? <Text style={styles.reviewText}>{r.text}</Text> : null}
          </View>
        ))}
      </View>

      <Modal visible={inviteOpen} animationType="slide" transparent onRequestClose={() => setInviteOpen(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setInviteOpen(false)} />
          <View style={styles.inviteSheet}>
            <View style={styles.handle} />
            <Text style={styles.inviteSheetTitle}>Invite {profile.name || 'them'} to…</Text>
            <ScrollView style={{ maxHeight: 360 }} showsVerticalScrollIndicator={false}>
              {myOpenGigs.map(j => (
                <TouchableOpacity key={j.id} style={styles.inviteRow} onPress={() => sendInvite(j)}>
                  <View style={styles.rowGrow}>
                    <Text style={styles.inviteRowTitle} numberOfLines={1}>{j.title}</Text>
                    <Text style={styles.inviteRowMeta} numberOfLines={1}>{j.payType === 'hourly' ? `$${j.pay}/hr` : `$${j.pay} flat`} · {maskLocation(j.location)}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={colors.textMuted} style={styles.rowChevron} />
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity onPress={() => setInviteOpen(false)} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {sharedBooking && (
        <MessageSheet
          visible={msgOpen}
          bookingId={sharedBooking.booking.id}
          jobId={sharedBooking.booking.jobId}
          jobTitle={sharedBooking.jobTitle}
          otherPerson={{ id: userId, name: profile.name, avatarInitial: profile.avatar_initial, avatarUrl: profile.avatar_url }}
          onClose={() => setMsgOpen(false)}
          onViewJob={(jid) => { setMsgOpen(false); navigation.navigate('JobDetail', { jobId: jid }); }}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, padding: 20 },
  muted: { fontSize: 14, color: colors.textMuted, lineHeight: 20 },

  // ── Header ────────────────────────────────────────────────────────────────
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  headerInfo: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  name: { fontSize: 24, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.4, lineHeight: 30, flexShrink: 1 },
  nameIcon: { marginLeft: 6, flexShrink: 0 },
  // No explicit lineHeight: the "rating · reviews · since" line can legitimately
  // render as an empty string, and a forced line box would leave a blank gap.
  subMeta: { fontSize: 12, color: colors.textMuted, marginTop: 4 },
  headerActions: { flexDirection: 'row', alignItems: 'center', flexShrink: 0, marginLeft: 8 },
  favBtn: {
    width: 36, height: 36, borderRadius: radii.pill, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', marginLeft: 6,
  },

  // ── Report / block action sheet ───────────────────────────────────────────
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    padding: 12, paddingBottom: 28,
  },
  sheetTitle: { fontSize: 13, fontWeight: '600', color: colors.textMuted, lineHeight: 18, padding: 12 },
  sheetItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 12, borderRadius: radii.md },
  sheetText: { fontSize: 15, fontWeight: '600', color: colors.textPrimary, lineHeight: 20, flexShrink: 1 },

  // ── Rating breakdown ──────────────────────────────────────────────────────
  breakRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    marginHorizontal: 20, marginTop: 16, borderRadius: radii.lg, paddingVertical: 16,
    ...shadows.card,
  },
  breakItem: { flex: 1, alignItems: 'center', paddingHorizontal: 8 },
  breakVal: { fontSize: 20, fontWeight: '700', color: colors.textPrimary, marginTop: 4, lineHeight: 26 },
  breakLabel: { fontSize: 12, color: colors.textMuted, fontWeight: '500', marginTop: 4, lineHeight: 16, textAlign: 'center' },
  breakDivider: { width: 1, height: 44, backgroundColor: colors.divider },

  // ── Primary / secondary actions ───────────────────────────────────────────
  actionRow: { flexDirection: 'row', marginHorizontal: 20, marginTop: 12 },
  actionBtn: { flex: 1, marginHorizontal: 0, marginTop: 0 },
  actionBtnOutline: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  inviteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary, borderRadius: radii.md,
    paddingVertical: 14, paddingHorizontal: 16,
    marginHorizontal: 20, marginTop: 12,
  },
  inviteBtnText: { color: '#fff', fontSize: 15, fontWeight: '600', lineHeight: 20, flexShrink: 1 },
  inviteBtnTextOutline: { color: colors.textPrimary },

  // ── Invite bottom sheet ───────────────────────────────────────────────────
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  inviteSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    paddingHorizontal: 20, paddingBottom: 36, ...shadows.md,
  },
  handle: { width: 40, height: 4, borderRadius: radii.pill, backgroundColor: colors.border, alignSelf: 'center', marginTop: 12, marginBottom: 16 },
  inviteSheetTitle: { fontSize: 18, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.2, lineHeight: 24, marginBottom: 12 },
  inviteRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.divider },
  inviteRowTitle: { fontSize: 15, fontWeight: '600', color: colors.textPrimary, lineHeight: 20 },
  inviteRowMeta: { fontSize: 12, color: colors.textMuted, marginTop: 4, lineHeight: 16 },
  cancelBtn: { paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  cancelText: { fontSize: 14, color: colors.textMuted, fontWeight: '500', lineHeight: 18 },

  // ── Sections ──────────────────────────────────────────────────────────────
  section: { paddingHorizontal: 20, marginTop: 24 },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: colors.textMuted, lineHeight: 18, marginBottom: 12 },
  bio: { fontSize: 15, color: colors.textSecondary, lineHeight: 22 },

  // Shared row helpers: the text column yields space so the trailing icon /
  // value can never be pushed off-screen.
  rowGrow: { flex: 1, minWidth: 0, marginRight: 12 },
  rowChevron: { flexShrink: 0 },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  skillChip: {
    alignSelf: 'flex-start', maxWidth: '100%',
    backgroundColor: colors.surface, borderRadius: radii.pill,
    paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.border,
  },
  skillText: { fontSize: 12, fontWeight: '500', color: colors.textSecondary, lineHeight: 16, flexShrink: 1 },

  // ── Availability ──────────────────────────────────────────────────────────
  availCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16, ...shadows.card },
  availStatusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.divider },
  availStatusDot: { width: 10, height: 10, borderRadius: radii.pill, marginRight: 8, flexShrink: 0 },
  availStatusLabel: { fontSize: 14, fontWeight: '600', color: colors.textPrimary, lineHeight: 18, flexShrink: 1 },
  availRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.divider },
  availDay: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, lineHeight: 18, width: 48, flexShrink: 0, marginRight: 12 },
  availTimes: { flex: 1, textAlign: 'right', fontSize: 13, fontWeight: '500', color: colors.textSecondary, lineHeight: 18 },

  // ── Certifications ────────────────────────────────────────────────────────
  certCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    borderRadius: radii.lg, padding: 16, marginBottom: 8, ...shadows.card,
  },
  certThumb: { width: 44, height: 44, borderRadius: radii.md, marginRight: 12, backgroundColor: colors.background },
  certThumbPlaceholder: {
    width: 44, height: 44, borderRadius: radii.md, marginRight: 12,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background,
  },
  certTitle: { fontSize: 15, fontWeight: '600', color: colors.textPrimary, lineHeight: 20 },
  certMeta: { fontSize: 12, color: colors.textMuted, marginTop: 4, lineHeight: 16 },
  certWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  certifiedBadge: {
    alignSelf: 'flex-start', maxWidth: '100%',
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.successLight, borderRadius: radii.md,
    paddingHorizontal: 12, paddingVertical: 10,
  },
  certifiedTextWrap: { flexShrink: 1, minWidth: 0 },
  certifiedTitle: { fontSize: 13, fontWeight: '600', color: colors.success, lineHeight: 18 },
  certifiedSub: { fontSize: 12, fontWeight: '400', color: colors.success, marginTop: 4, lineHeight: 16 },

  // ── Progress to certification ─────────────────────────────────────────────
  progressCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16, ...shadows.card },
  progressRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  progressLabel: { fontSize: 14, fontWeight: '500', color: colors.textPrimary, lineHeight: 18, flexShrink: 1, minWidth: 0, marginRight: 12 },
  progressCount: { fontSize: 14, fontWeight: '600', color: colors.textMuted, lineHeight: 18, flexShrink: 0 },

  // ── Open gigs ─────────────────────────────────────────────────────────────
  jobRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    borderRadius: radii.lg, padding: 16, marginBottom: 8, ...shadows.card,
  },
  jobTitle: { fontSize: 15, fontWeight: '600', color: colors.textPrimary, lineHeight: 20 },
  jobMeta: { fontSize: 12, color: colors.textMuted, marginTop: 4, lineHeight: 16 },

  // ── Recent work ───────────────────────────────────────────────────────────
  workCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16, marginBottom: 8, ...shadows.card },
  workTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  workTitle: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '600', color: colors.textPrimary, lineHeight: 20 },
  workReview: { fontSize: 14, color: colors.textSecondary, lineHeight: 20, marginTop: 8 },

  // ── Self banner ───────────────────────────────────────────────────────────
  selfBanner: {
    flexDirection: 'row', alignItems: 'center', marginHorizontal: 20, marginTop: 16,
    backgroundColor: colors.surface, borderRadius: radii.lg,
    paddingHorizontal: 16, paddingVertical: 12,
    borderWidth: 1, borderColor: colors.border,
  },
  selfBannerText: { flex: 1, fontSize: 13, fontWeight: '500', color: colors.textSecondary, lineHeight: 18 },

  // ── Reviews ───────────────────────────────────────────────────────────────
  reviewCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16, marginBottom: 12, ...shadows.card },
  reviewHead: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  reviewer: { fontSize: 14, fontWeight: '600', color: colors.textPrimary, lineHeight: 18, marginBottom: 4 },
  reviewMetaRow: { flexDirection: 'row', alignItems: 'center' },
  roleTag: {
    alignSelf: 'flex-start', flexShrink: 1, minWidth: 0, backgroundColor: colors.background,
    borderRadius: radii.sm, paddingHorizontal: 8, paddingVertical: 4, marginLeft: 8,
  },
  roleTagText: { fontSize: 11, fontWeight: '500', color: colors.textMuted, lineHeight: 15 },
  reviewDate: { fontSize: 12, color: colors.textMuted, lineHeight: 18, flexShrink: 0, marginLeft: 8 },
  reviewText: { fontSize: 14, color: colors.textSecondary, lineHeight: 20 },
});
