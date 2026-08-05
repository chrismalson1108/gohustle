import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import MessageSheet from '../components/MessageSheet';
import Avatar from '../components/Avatar';
import { useJobs } from '../context/JobsContext';
import { useHaptic } from '../hooks/useHaptic';
import { colors, radii } from '../theme';

// A conversation, as a real screen rather than the old 75%-tall bottom sheet.
//
// The sheet had two problems the moment you typed: the keyboard covered most of
// the little conversation that was visible, and the only way out was a close
// button (no swipe-back, no native chevron). As a stack screen it gets the same
// back control as every other screen, full height for the thread, and room for a
// job card up top so you can see WHICH gig you're discussing and jump to it.
//
// The chat body itself is still MessageSheet in `embedded` mode — one
// implementation of loading, realtime, sending and image upload, two hosts.
export default function ChatScreen({ route, navigation }) {
  const { bookingId, jobId, jobTitle, otherPerson } = route.params || {};
  const { jobs, fetchJobById } = useJobs();
  const haptic = useHaptic();
  const [job, setJob] = useState(() => (jobs || []).find(j => j.id === jobId) || null);

  // The gig may be past or soft-deleted and therefore absent from the browse
  // list — fall back to a direct fetch so the header still resolves.
  useEffect(() => {
    if (job || !jobId || !fetchJobById) return;
    let active = true;
    fetchJobById(jobId).then(j => { if (active && j) setJob(j); }).catch(() => {});
    return () => { active = false; };
  }, [jobId, job, fetchJobById]);

  // No native title on purpose. DETAIL_OPTS keeps `title: ''` app-wide precisely so
  // a screen that draws its own header doesn't show the same name twice (App.js), and
  // this screen already names the person in the pinned context bar below — which is
  // also the tap target for their profile. Setting a title here put "Roman Hinton" in
  // the nav bar and again two lines under it.

  const title = job?.title || jobTitle;
  const photo = job?.photos?.[0] || null;
  const openJob = () => {
    if (!jobId) return;
    haptic.light();
    navigation.navigate('JobDetail', { jobId });
  };
  const openProfile = () => {
    if (!otherPerson?.id) return;
    haptic.light();
    navigation.navigate('UserProfile', { userId: otherPerson.id });
  };

  return (
    <View style={styles.container}>
      {/* Context bar: who, and about what. Both halves are tappable, so the
          conversation is never a dead end — you can always get to the gig or to
          the person from here. */}
      <View style={styles.contextBar}>
        <TouchableOpacity style={styles.personRow} onPress={openProfile} activeOpacity={0.7} disabled={!otherPerson?.id}>
          <Avatar
            url={otherPerson?.avatarUrl}
            initial={otherPerson?.avatarInitial || otherPerson?.name?.[0]}
            size={32}
            fontSize={14}
          />
          <View style={styles.personText}>
            <Text style={styles.personName} numberOfLines={1}>{otherPerson?.name || 'Chat'}</Text>
            <Text style={styles.personHint} numberOfLines={1}>View profile</Text>
          </View>
          {otherPerson?.id ? <Ionicons name="chevron-forward" size={16} color={colors.textMuted} /> : null}
        </TouchableOpacity>

        {title ? (
          <TouchableOpacity style={styles.jobCard} onPress={openJob} activeOpacity={0.8} disabled={!jobId}>
            {photo
              ? <Image source={{ uri: photo }} style={styles.jobPhoto} resizeMode="cover" />
              : (
                <View style={[styles.jobPhoto, styles.jobPhotoFallback]}>
                  <Ionicons name="briefcase-outline" size={18} color={colors.textMuted} />
                </View>
              )}
            <View style={styles.jobText}>
              <Text style={styles.jobTitle} numberOfLines={1}>{title}</Text>
              <Text style={styles.jobMeta} numberOfLines={1}>
                {job?.pay != null
                  ? `$${job.pay}${job.payType === 'hourly' ? '/hr' : ''}${job.location ? ` · ${job.location}` : ''}`
                  : 'Tap to see the gig'}
              </Text>
            </View>
            {jobId ? <Ionicons name="chevron-forward" size={16} color={colors.textMuted} /> : null}
          </TouchableOpacity>
        ) : null}
      </View>

      <MessageSheet
        embedded
        visible
        bookingId={bookingId}
        jobId={jobId}
        jobTitle={title}
        otherPerson={otherPerson}
        onClose={() => navigation.goBack()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  contextBar: {
    paddingHorizontal: 16, paddingBottom: 12,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider,
  },
  personRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  personText: { flex: 1, marginLeft: 10, marginRight: 8 },
  personName: { fontSize: 15, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.2 },
  personHint: { fontSize: 12, color: colors.textMuted, marginTop: 1 },

  jobCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.background, borderRadius: radii.md,
    padding: 8, marginTop: 4,
  },
  jobPhoto: { width: 40, height: 40, borderRadius: radii.sm, backgroundColor: colors.divider },
  jobPhotoFallback: { alignItems: 'center', justifyContent: 'center' },
  jobText: { flex: 1, marginLeft: 10, marginRight: 8 },
  jobTitle: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  jobMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
});
