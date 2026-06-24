import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { listNotifications, markRead, markAllRead, setArchived, notificationRoute } from '../lib/notifications';
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

function iconFor(type) {
  if (type === 'saved_search') return 'briefcase';
  if (type === 'message') return 'chatbubble';
  return 'notifications';
}

export default function NotificationsScreen({ navigation }) {
  const [tab, setTab] = useState('inbox'); // 'inbox' | 'archived'
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (t = tab) => {
    setItems(await listNotifications(t === 'archived'));
    setLoading(false);
  }, [tab]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const switchTab = (t) => { setTab(t); setLoading(true); load(t); };

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const open = (n) => {
    if (!n.read) markRead(n.id);
    if (tab === 'inbox') {
      // Auto-archive on view — handled alerts leave the inbox (still in Archived).
      setArchived(n.id, true);
      setItems((xs) => xs.filter((x) => x.id !== n.id));
    }
    const r = notificationRoute(n);
    if (r) {
      if (r.screen) navigation.navigate(r.tab, { screen: r.screen, params: r.params });
      else navigation.navigate(r.tab);
    }
  };

  const archive = async (n) => {
    await setArchived(n.id, tab === 'inbox');
    setItems((xs) => xs.filter((x) => x.id !== n.id));
  };

  const allRead = async () => {
    await markAllRead();
    setItems((xs) => xs.map((x) => ({ ...x, read: true })));
  };

  const hasUnread = items.some((i) => !i.read);

  return (
    <View style={styles.screen}>
      <View style={styles.segment}>
        {['inbox', 'archived'].map((t) => (
          <TouchableOpacity key={t} style={[styles.segBtn, tab === t && styles.segBtnActive]} onPress={() => switchTab(t)}>
            <Text style={[styles.segText, tab === t && styles.segTextActive]}>{t === 'inbox' ? 'Inbox' : 'Archived'}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'inbox' && hasUnread && (
        <TouchableOpacity style={styles.markAll} onPress={allRead}>
          <Text style={styles.markAllText}>Mark all read</Text>
        </TouchableOpacity>
      )}

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingTop: 8, gap: 8 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {loading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
        ) : items.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="notifications-outline" size={44} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>{tab === 'inbox' ? 'No alerts yet' : 'Nothing archived'}</Text>
            <Text style={styles.emptyBody}>
              {tab === 'inbox'
                ? 'Booking updates, messages, and gig matches show up here. Ask Hustlr AI to watch for gigs (e.g. “tell me when photography gigs come up”).'
                : 'Alerts you archive are kept here.'}
            </Text>
          </View>
        ) : (
          items.map((n) => (
            <View key={n.id} style={[styles.row, !n.read && tab === 'inbox' && styles.rowUnread]}>
              <View style={styles.rowIcon}>
                <Ionicons name={iconFor(n.type)} size={20} color={colors.primary} />
              </View>
              <TouchableOpacity style={{ flex: 1 }} onPress={() => open(n)} activeOpacity={0.85}>
                <Text style={styles.rowTitle}>{n.title}</Text>
                {!!n.body && <Text style={styles.rowBody} numberOfLines={1}>{n.body}</Text>}
                <Text style={styles.rowTime}>{relTime(n.created_at)}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => archive(n)} style={styles.rowAction} accessibilityLabel={tab === 'inbox' ? 'Archive' : 'Move to inbox'}>
                <Ionicons name={tab === 'inbox' ? 'close' : 'arrow-undo-outline'} size={18} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  segment: { flexDirection: 'row', gap: 4, backgroundColor: colors.divider, borderRadius: 14, padding: 4, margin: 16, marginBottom: 4 },
  segBtn: { flex: 1, alignItems: 'center', borderRadius: 10, paddingVertical: 8 },
  segBtnActive: { backgroundColor: colors.surface, ...shadows.sm },
  segText: { fontSize: 13.5, fontWeight: '800', color: colors.textSecondary },
  segTextActive: { color: colors.primary },
  markAll: { alignSelf: 'flex-end', paddingHorizontal: 16, paddingTop: 6 },
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
  rowAction: { padding: 4 },
});
