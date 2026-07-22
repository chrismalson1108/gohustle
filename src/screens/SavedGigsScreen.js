import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import JobCard from '../components/JobCard';
import { useJobs } from '../context/JobsContext';
import { colors } from '../theme';

export default function SavedGigsScreen({ navigation }) {
  const { jobs, savedJobIds, bookings, refreshJobs } = useJobs();
  const [refreshing, setRefreshing] = useState(false);

  const saved = jobs.filter(j => savedJobIds.has(j.id));

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
      ) : saved.map(job => (
        <JobCard
          key={job.id}
          job={job}
          bookingStatus={bookings.find(b => b.jobId === job.id)?.status}
          onPress={() => navigation.navigate('JobDetail', { jobId: job.id })}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  empty: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 56 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary, marginBottom: 8, letterSpacing: -0.2, lineHeight: 22 },
  emptyText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 21 },
});
