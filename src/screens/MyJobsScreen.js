import React, { useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { useJobs } from '../context/JobsContext';
import JobCard from '../components/JobCard';
import { colors } from '../theme';

export default function MyJobsScreen({ navigation }) {
  const { jobs, myPostedIds, appliedIds } = useJobs();
  const [tab, setTab] = useState('applied');

  const appliedJobs = jobs.filter(j => appliedIds.includes(j.id));
  const postedJobs = jobs.filter(j => myPostedIds.includes(j.id));
  const data = tab === 'applied' ? appliedJobs : postedJobs;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.heading}>My Activity</Text>
        <View style={styles.tabRow}>
          {[
            { key: 'applied', label: `Applied (${appliedJobs.length})` },
            { key: 'posted', label: `Posted (${postedJobs.length})` },
          ].map(t => (
            <TouchableOpacity
              key={t.key}
              style={[styles.tab, tab === t.key && styles.tabActive]}
              onPress={() => setTab(t.key)}
            >
              <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>
                {t.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <FlatList
        data={data}
        keyExtractor={j => j.id}
        renderItem={({ item }) => (
          <JobCard
            job={item}
            onPress={() => navigation.navigate('JobDetail', { jobId: item.id })}
          />
        )}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>{tab === 'applied' ? '📋' : '📝'}</Text>
            <Text style={styles.emptyTitle}>
              {tab === 'applied' ? 'No applications yet' : 'No gigs posted yet'}
            </Text>
            <Text style={styles.emptyText}>
              {tab === 'applied'
                ? "Browse gigs and tap \"I'm Interested!\" to apply."
                : 'Use the Post tab to create your first gig.'}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    backgroundColor: '#fff',
    paddingTop: 60,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  heading: {
    fontSize: 26,
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: 16,
  },
  tabRow: { flexDirection: 'row' },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: { borderBottomColor: colors.primary },
  tabText: { fontSize: 14, fontWeight: '600', color: colors.textSecondary },
  tabTextActive: { color: colors.primary },
  list: { paddingTop: 16, paddingBottom: 20 },
  empty: { alignItems: 'center', padding: 40 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
});
