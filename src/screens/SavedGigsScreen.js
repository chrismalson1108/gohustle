import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import JobCard from '../components/JobCard';
import { useJobs } from '../context/JobsContext';
import { useAuth } from '../context/AuthContext';
import { isJobBookable, isHiddenForViewer } from '../lib/filters';
import { colors } from '../theme';

export default function SavedGigsScreen({ navigation }) {
  const { jobs, savedJobIds, bookings, refreshJobs } = useJobs();
  const { user } = useAuth();
  const [refreshing, setRefreshing] = useState(false);

  const saved = jobs.filter(j => savedJobIds.has(j.id));
  // Same two predicates Browse uses, but SPLIT rather than filtered out: the user
  // deliberately bookmarked these, so a gig silently vanishing here reads as a lost
  // bookmark, not a closed gig. Keep them, muted, where they can still be unsaved.
  //
  // Your own listing is booked-out for YOU no matter what its slots say, so it
  // belongs in the closed group too — otherwise "Ready to book" sends you to a
  // JobDetail that just tells you it's your gig.
  const stillOpen = j => isJobBookable(j) && !isHiddenForViewer(j, bookings) && j.posterId !== user?.id;
  const open = saved.filter(stillOpen);
  const closed = saved.filter(j => !stillOpen(j));

  const onRefresh = async () => {
    setRefreshing(true);
    try { await refreshJobs(); } catch (_) {}
    setRefreshing(false);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingVertical: 16 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      {saved.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="bookmark-outline" size={44} color={colors.textMuted} style={{ marginBottom: 12 }} />
          <Text style={styles.emptyTitle}>No saved gigs yet</Text>
          <Text style={styles.emptyText}>Tap the bookmark on any gig to save it here to book later.</Text>
        </View>
      ) : (
        <>
          {open.length > 0 && (
            <>
              {closed.length > 0 && <Text style={styles.sectionTitle}>Ready to book</Text>}
              {open.map(job => (
                <JobCard
                  key={job.id}
                  job={job}
                  bookingStatus={bookings.find(b => b.jobId === job.id)?.status}
                  onPress={() => navigation.navigate('JobDetail', { jobId: job.id })}
                />
              ))}
            </>
          )}
          {closed.length > 0 && (
            <>
              <Text style={[styles.sectionTitle, open.length > 0 && { marginTop: 20 }]}>No longer open</Text>
              <Text style={styles.sectionHint}>Fully booked, or your own listing. Unsave to tidy this list up.</Text>
              <View style={styles.dimmed}>
                {closed.map(job => (
                  <JobCard
                    key={job.id}
                    job={job}
                    bookingStatus={bookings.find(b => b.jobId === job.id)?.status}
                    onPress={() => navigation.navigate('JobDetail', { jobId: job.id })}
                  />
                ))}
              </View>
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: colors.textMuted, paddingHorizontal: 16, marginBottom: 8 },
  sectionHint: { fontSize: 12, color: colors.textSecondary, paddingHorizontal: 16, marginBottom: 12, lineHeight: 17 },
  dimmed: { opacity: 0.55 },
  empty: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 56 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary, marginBottom: 8, letterSpacing: -0.2, lineHeight: 22 },
  emptyText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 21 },
});
