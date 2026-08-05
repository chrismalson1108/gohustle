import React, { useState, useEffect, useLayoutEffect } from 'react';
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

  // Who you're talking to goes IN the native bar, next to the back chevron — the
  // pattern every messaging app uses, and the row exists anyway. Previously the bar
  // held a plain text title while the same name was repeated in a context row below,
  // so the screen spent two rows saying it once. Dropping the text title left the bar
  // visibly empty; this fills it and lets the context row below shrink to just the gig.
  //
  // It stays a headerTitle rather than a custom header so the NATIVE back button is
  // untouched — App.js documents that a hand-rolled back control in that strip loses
  // taps to the screen-edge pop gesture.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <TouchableOpacity
          style={styles.headerPerson}
          onPress={openProfile}
          activeOpacity={0.7}
          disabled={!otherPerson?.id}
          accessibilityRole="button"
          accessibilityLabel={otherPerson?.name ? `${otherPerson.name}, view profile` : 'Chat'}
        >
          <Avatar
            url={otherPerson?.avatarUrl}
            initial={otherPerson?.avatarInitial || otherPerson?.name?.[0]}
            size={26}
            fontSize={12}
          />
          <Text style={styles.headerPersonName} numberOfLines={1}>
            {otherPerson?.name || 'Chat'}
          </Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, otherPerson?.id, otherPerson?.name, otherPerson?.avatarUrl, otherPerson?.avatarInitial]);

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
      {/* Context row: WHICH gig this is about, so the conversation is never a dead
          end. The person half moved into the native bar — see the headerTitle above. */}
      <View style={styles.contextBar}>
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
  headerPerson: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 220 },
  headerPersonName: {
    fontSize: 16, fontWeight: '700', color: colors.textPrimary,
    letterSpacing: -0.2, flexShrink: 1,
  },

  contextBar: {
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider,
  },

  jobCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.background, borderRadius: radii.md,
    padding: 8,
  },
  jobPhoto: { width: 40, height: 40, borderRadius: radii.sm, backgroundColor: colors.divider },
  jobPhotoFallback: { alignItems: 'center', justifyContent: 'center' },
  jobText: { flex: 1, marginLeft: 10, marginRight: 8 },
  jobTitle: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  jobMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
});
