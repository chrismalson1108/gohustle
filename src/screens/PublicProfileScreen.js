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
import GradientHeader from '../components/GradientHeader';
import Avatar from '../components/Avatar';
import RatingStars from '../components/RatingStars';
import { collegeLine } from '../lib/school';
import { DAYS, windowsForDay, fmtTime, workStatusMeta } from '../lib/availability';
import { colors, gradients, shadows } from '../theme';
import { CATEGORY_COLORS } from '../data/mockData';

const avg = (arr) => arr.length ? (arr.reduce((s, r) => s + Number(r.rating || 0), 0) / arr.length) : null;

export default function PublicProfileScreen({ route, navigation }) {
  const { userId } = route.params;
  const { user } = useAuth();
  const { name: myName, showToast } = useUser();
  const { postedJobs, blockUser } = useJobs();
  const haptic = useHaptic();
  const isSelf = user?.id === userId;
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

  const sendInvite = (job) => {
    haptic.success();
    notify(userId, 'You got a gig invitation', `${myName || 'Someone'} invited you to apply to "${job.title}"`, { tab: 'HomeTab' });
    setInviteOpen(false);
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
      <GradientHeader colors={gradients.profile}>
        <View style={styles.headerRow}>
          <Avatar url={profile.avatar_url} initial={profile.avatar_initial || profile.name?.[0]} size={64} fontSize={26}
            bg="rgba(255,255,255,0.25)" borderColor="rgba(255,255,255,0.6)" borderWidth={3} style={{ marginRight: 16 }} />
          <View style={{ flex: 1 }}>
            <View style={styles.nameRow}>
              <Text style={styles.name}>{profile.name || 'GoHustlr user'}</Text>
              {profile.verified && <Ionicons name="checkmark-circle" size={16} color="#fff" style={{ marginLeft: 6 }} />}
              {profile.student_verified && <Ionicons name="school" size={14} color="#fff" style={{ marginLeft: 6 }} />}
            </View>
            {overall != null
              ? <RatingStars rating={overall} size={14} />
              : <Text style={styles.subWhite}>No reviews yet</Text>}
            <Text style={styles.subWhite}>
              {reviews.length > 0 ? `${overall.toFixed(1)} · ${reviews.length} review${reviews.length !== 1 ? 's' : ''}` : ''}
              {profile.member_since ? `${reviews.length ? ' · ' : ''}Since ${profile.member_since}` : ''}
            </Text>
            {!!collegeLine(profile) && <Text style={styles.subWhite}>{collegeLine(profile)}</Text>}
            {profile.city ? <Text style={styles.subWhite}>{profile.city}</Text> : null}
          </View>
          {!isSelf && user && (
            <View style={styles.headerActions}>
              <TouchableOpacity onPress={toggleFav} style={styles.favBtn} activeOpacity={0.8}>
                <Ionicons name={fav ? 'heart' : 'heart-outline'} size={22} color={fav ? '#FB7185' : '#fff'} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setMenuOpen(true)} style={styles.favBtn} activeOpacity={0.8} accessibilityLabel="More options">
                <Ionicons name="ellipsis-horizontal" size={22} color="#fff" />
              </TouchableOpacity>
            </View>
          )}
        </View>
      </GradientHeader>

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
          <Ionicons name="briefcase" size={16} color={colors.primary} />
          <Text style={styles.breakVal}>{workerAvg != null ? workerAvg.toFixed(1) : '—'}</Text>
          <Text style={styles.breakLabel}>As a worker ({workerReviews.length})</Text>
        </View>
        <View style={styles.breakDivider} />
        <View style={styles.breakItem}>
          <Ionicons name="megaphone" size={16} color={colors.primary} />
          <Text style={styles.breakVal}>{clientAvg != null ? clientAvg.toFixed(1) : '—'}</Text>
          <Text style={styles.breakLabel}>As a client ({clientReviews.length})</Text>
        </View>
      </View>

      {isSelf && (
        <View style={styles.selfBanner}>
          <Ionicons name="eye-outline" size={15} color={colors.primary} style={{ marginRight: 8 }} />
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
                  <Text style={styles.availStatusLabel}>{ws.label}</Text>
                </View>
              );
            })()}
            {availDays.map(({ label, day, windows }) => (
              <View key={day} style={styles.availRow}>
                <Text style={styles.availDay}>{label}</Text>
                <Text style={styles.availTimes}>
                  {windows.map((w) => `${fmtTime(w.start)}–${fmtTime(w.end)}`).join(', ')}
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {!isSelf && user && myOpenGigs.length > 0 && (
        <TouchableOpacity style={styles.inviteBtn} onPress={() => setInviteOpen(true)} activeOpacity={0.85}>
          <Ionicons name="paper-plane-outline" size={16} color="#fff" style={{ marginRight: 6 }} />
          <Text style={styles.inviteBtnText}>Invite to a gig</Text>
        </TouchableOpacity>
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
                <Text style={styles.skillText}>{s}{profile.skill_rates?.[s] ? ` · $${profile.skill_rates[s]}/hr` : ''}</Text>
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
                <View>
                  <Text style={styles.certifiedTitle}>Certified · {c.label}</Text>
                  <Text style={styles.certifiedSub}>{c.count} jobs</Text>
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
                <Text style={styles.progressLabel}>{p.label}</Text>
                <Text style={styles.progressCount}>{p.count}/{p.needed}</Text>
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
                  <Ionicons name="ribbon-outline" size={20} color={colors.primary} />
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.certTitle} numberOfLines={1}>{c.title}</Text>
                {(c.issuer || c.year) ? (
                  <Text style={styles.certMeta} numberOfLines={1}>{[c.issuer, c.year].filter(Boolean).join(' · ')}</Text>
                ) : null}
              </View>
              {certImg ? <Ionicons name="open-outline" size={16} color={colors.textMuted} /> : null}
            </TouchableOpacity>
            );
          })}
        </View>
      )}

      {listings.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Open gigs they posted ({listings.length})</Text>
          {listings.map(j => {
            const cc = CATEGORY_COLORS[j.category] || colors.primary;
            return (
              <TouchableOpacity key={j.id} style={styles.jobRow} onPress={() => navigation.navigate('JobDetail', { jobId: j.id })}>
                <View style={[styles.jobAccent, { backgroundColor: cc }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.jobTitle} numberOfLines={1}>{j.title}</Text>
                  <Text style={styles.jobMeta}>{j.pay_type === 'hourly' ? `$${j.pay}/hr` : `$${j.pay} flat`} · {j.location}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            );
          })}
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
              <View style={{ flex: 1 }}>
                <Text style={styles.reviewer}>{r.reviewer?.name || 'User'}</Text>
                <View style={styles.reviewMetaRow}>
                  <RatingStars rating={r.rating} size={11} />
                  <View style={[styles.roleTag, r.role === 'poster' && styles.roleTagClient]}>
                    <Text style={[styles.roleTagText, r.role === 'poster' && styles.roleTagTextClient]}>
                      {r.role === 'poster' ? 'as a client' : 'as a worker'}
                    </Text>
                  </View>
                </View>
              </View>
              {r.date ? <Text style={styles.reviewDate}>{r.date}</Text> : null}
            </View>
            {r.text ? <Text style={styles.reviewText}>{r.text}</Text> : null}
          </View>
        ))}
      </View>

      <Modal visible={inviteOpen} animationType="slide" transparent onRequestClose={() => setInviteOpen(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setInviteOpen(false)} />
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Invite {profile.name || 'them'} to…</Text>
            <ScrollView style={{ maxHeight: 360 }} showsVerticalScrollIndicator={false}>
              {myOpenGigs.map(j => (
                <TouchableOpacity key={j.id} style={styles.inviteRow} onPress={() => sendInvite(j)}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.inviteRowTitle} numberOfLines={1}>{j.title}</Text>
                    <Text style={styles.inviteRowMeta}>{j.payType === 'hourly' ? `$${j.pay}/hr` : `$${j.pay} flat`} · {j.location}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity onPress={() => setInviteOpen(false)} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, padding: 24 },
  muted: { fontSize: 14, color: colors.textMuted },
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  favBtn: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center', marginLeft: 8,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 12, paddingBottom: 28 },
  sheetTitle: { fontSize: 13, fontWeight: '800', color: colors.textMuted, padding: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  sheetItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 12, borderRadius: 12 },
  sheetText: { fontSize: 15.5, fontWeight: '700', color: colors.textPrimary },
  nameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  name: { fontSize: 22, fontWeight: '900', color: '#fff' },
  subWhite: { fontSize: 12, color: 'rgba(255,255,255,0.8)', marginTop: 3 },
  breakRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    marginHorizontal: 16, marginTop: 16, borderRadius: 16, paddingVertical: 16,
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  breakItem: { flex: 1, alignItems: 'center' },
  breakVal: { fontSize: 20, fontWeight: '900', color: colors.textPrimary, marginTop: 4 },
  breakLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '600', marginTop: 2 },
  breakDivider: { width: 1, height: 44, backgroundColor: colors.border },
  inviteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 13,
    marginHorizontal: 16, marginTop: 12,
  },
  inviteBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingBottom: 36, ...shadows.md },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginTop: 12, marginBottom: 16 },
  sheetTitle: { fontSize: 18, fontWeight: '900', color: colors.textPrimary, marginBottom: 12 },
  inviteRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.divider },
  inviteRowTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  inviteRowMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  cancelBtn: { paddingVertical: 14, alignItems: 'center', marginTop: 6 },
  cancelText: { fontSize: 14, color: colors.textMuted, fontWeight: '600' },
  section: { paddingHorizontal: 16, marginTop: 24 },
  sectionTitle: { fontSize: 13, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 12 },
  bio: { fontSize: 14, color: colors.textSecondary, lineHeight: 21 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap' },
  skillChip: { backgroundColor: colors.primaryLight, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8, marginBottom: 8 },
  skillText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  jobRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    borderRadius: 14, padding: 12, marginBottom: 8, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  jobAccent: { width: 4, height: 36, borderRadius: 2, marginRight: 12 },
  availCard: { backgroundColor: colors.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.border, ...shadows.sm },
  availStatusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.divider },
  availStatusDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  availStatusLabel: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  availRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.divider },
  availDay: { fontSize: 13, fontWeight: '800', color: colors.primary, width: 48 },
  availTimes: { flex: 1, textAlign: 'right', fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  certCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    borderRadius: 14, padding: 12, marginBottom: 8,
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  certThumb: { width: 44, height: 44, borderRadius: 8, marginRight: 12 },
  certThumbPlaceholder: {
    width: 44, height: 44, borderRadius: 8, marginRight: 12,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primaryLight,
  },
  certTitle: { fontSize: 14, fontWeight: '800', color: colors.textPrimary },
  certMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  certWrap: { flexDirection: 'row', flexWrap: 'wrap' },
  certifiedBadge: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.successLight,
    borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, marginRight: 8, marginBottom: 8,
  },
  certifiedTitle: { fontSize: 13, fontWeight: '800', color: colors.success },
  certifiedSub: { fontSize: 11, fontWeight: '600', color: colors.success, marginTop: 1 },
  progressCard: { backgroundColor: colors.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.border, ...shadows.sm },
  progressRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 5 },
  progressLabel: { fontSize: 13, fontWeight: '700', color: colors.textPrimary },
  progressCount: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  jobTitle: { fontSize: 14, fontWeight: '800', color: colors.textPrimary },
  jobMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  workRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7 },
  workText: { fontSize: 13, color: colors.textSecondary, flex: 1 },
  workCard: { backgroundColor: colors.surface, borderRadius: 14, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border, ...shadows.sm },
  workTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  workTitle: { flex: 1, fontSize: 14, fontWeight: '800', color: colors.textPrimary },
  workReview: { fontSize: 13, color: colors.textSecondary, lineHeight: 19, marginTop: 4 },
  selfBanner: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginTop: 16, backgroundColor: colors.primaryLight, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11 },
  selfBannerText: { flex: 1, fontSize: 13, fontWeight: '700', color: colors.primary },
  reviewCard: { backgroundColor: colors.surface, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: colors.border, ...shadows.sm },
  reviewHead: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  reviewer: { fontSize: 13, fontWeight: '800', color: colors.textPrimary, marginBottom: 3 },
  reviewMetaRow: { flexDirection: 'row', alignItems: 'center' },
  roleTag: { backgroundColor: colors.primaryLight, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, marginLeft: 8 },
  roleTagClient: { backgroundColor: '#FEF3C7' },
  roleTagText: { fontSize: 10, fontWeight: '700', color: colors.primary },
  roleTagTextClient: { color: '#B45309' },
  reviewDate: { fontSize: 11, color: colors.textMuted },
  reviewText: { fontSize: 13, color: colors.textSecondary, lineHeight: 20 },
});
