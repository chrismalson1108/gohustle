import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { listNotifications, markRead, markAllRead } from '../lib/notifications';
import { colors, shadows } from '../theme';

function relTime(iso) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function NotificationsScreen({ navigation }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setItems(await listNotifications());
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const open = (n) => {
    if (!n.read) {
      markRead(n.id);
      setItems((xs) => xs.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    }
    if (n.job_id) navigation.navigate('HomeTab', { screen: 'JobDetail', params: { jobId: n.job_id } });
  };

  const allRead = async () => {
    await markAllRead();
    setItems((xs) => xs.map((x) => ({ ...x, read: true })));
  };

  const hasUnread = items.some((i) => !i.read);

  return (
    <View style={styles.screen}>
      {hasUnread && (
        <TouchableOpacity style={styles.markAll} onPress={allRead}>
          <Text style={styles.markAllText}>Mark all read</Text>
        </TouchableOpacity>
      )}
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 8 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {loading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
        ) : items.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="notifications-outline" size={44} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>No alerts yet</Text>
            <Text style={styles.emptyBody}>
              Ask Hustlr AI to watch for gigs (e.g. “tell me when photography gigs come up”) and matches show up here.
            </Text>
          </View>
        ) : (
          items.map((n) => (
            <TouchableOpacity key={n.id} style={[styles.row, !n.read && styles.rowUnread]} onPress={() => open(n)} activeOpacity={0.85}>
              <View style={styles.rowIcon}>
                <Ionicons name={n.type === 'saved_search' ? 'briefcase' : 'notifications'} size={20} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{n.title}</Text>
                {!!n.body && <Text style={styles.rowBody} numberOfLines={1}>{n.body}</Text>}
                <Text style={styles.rowTime}>{relTime(n.created_at)}</Text>
              </View>
              {!n.read && <View style={styles.dot} />}
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  markAll: { alignSelf: 'flex-end', paddingHorizontal: 16, paddingTop: 10 },
  markAllText: { color: colors.primary, fontSize: 13, fontWeight: '800' },
  empty: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 48, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '900', color: colors.textPrimary },
  emptyBody: { fontSize: 13.5, color: colors.textMuted, textAlign: 'center', lineHeight: 19 },
  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12, backgroundColor: colors.surface,
    borderRadius: 16, padding: 14, borderWidth: 1, borderColor: colors.border,
  },
  rowUnread: { backgroundColor: colors.primaryLight, borderColor: colors.primary },
  rowIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: 14.5, fontWeight: '800', color: colors.textPrimary },
  rowBody: { fontSize: 13, color: colors.textSecondary, marginTop: 1 },
  rowTime: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary, marginTop: 4 },
});
