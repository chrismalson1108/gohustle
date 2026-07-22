import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { listNotifications, markRead, markAllRead, setArchived, notificationRoute } from '../lib/notifications';
import { colors, radii, shadows } from '../theme';

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
            <Text style={[styles.segText, tab === t && styles.segTextActive]} numberOfLines={1}>{t === 'inbox' ? 'Inbox' : 'Archived'}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'inbox' && hasUnread && (
        <TouchableOpacity style={styles.markAll} onPress={allRead}>
          <Text style={styles.markAllText} numberOfLines={1}>Mark all read</Text>
        </TouchableOpacity>
      )}

      <ScrollView
        contentContainerStyle={{ padding: 20, paddingTop: 8, gap: 12 }}
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
            <View key={n.id} style={styles.row}>
              <View style={styles.rowIcon}>
                <Ionicons name={iconFor(n.type)} size={20} color={colors.textSecondary} />
                {!n.read && tab === 'inbox' && <View style={styles.unreadDot} />}
              </View>
              <TouchableOpacity style={styles.rowMain} onPress={() => open(n)} activeOpacity={0.85}>
                <Text style={styles.rowTitle} numberOfLines={2}>{n.title}</Text>
                {!!n.body && <Text style={styles.rowBody} numberOfLines={1}>{n.body}</Text>}
                <Text style={styles.rowTime} numberOfLines={1}>{relTime(n.created_at)}</Text>
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
  // Same segmented control as Messages / Hiring / My Jobs so the app reads as one system.
  segment: {
    flexDirection: 'row', backgroundColor: colors.surface,
    borderRadius: radii.pill, padding: 4, marginHorizontal: 20, marginTop: 12, marginBottom: 4,
    borderWidth: 1, borderColor: colors.border,
  },
  segBtn: { flex: 1, alignItems: 'center', borderRadius: radii.pill, paddingVertical: 10, paddingHorizontal: 8 },
  segBtnActive: { backgroundColor: colors.primary },
  segText: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.textSecondary, flexShrink: 1 },
  segTextActive: { color: '#fff' },
  markAll: { alignSelf: 'flex-end', paddingHorizontal: 20, paddingTop: 8 },
  markAllText: { color: colors.primary, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  empty: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 48, gap: 8 },
  emptyTitle: { fontSize: 17, lineHeight: 23, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.2 },
  emptyBody: { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12, backgroundColor: colors.surface,
    borderRadius: radii.lg, padding: 16, ...shadows.card,
  },
  rowIcon: {
    width: 36, height: 36, borderRadius: radii.pill, flexShrink: 0,
    backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center',
  },
  // Unread marker — a dot on the icon bubble instead of tinting the whole card.
  unreadDot: {
    position: 'absolute', top: 0, right: 0,
    width: 10, height: 10, borderRadius: radii.pill, backgroundColor: colors.primary,
  },
  rowMain: { flex: 1, flexShrink: 1 },
  rowTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: colors.textPrimary },
  rowBody: { fontSize: 13.5, lineHeight: 18, color: colors.textSecondary, marginTop: 2 },
  rowTime: { fontSize: 12, lineHeight: 16, color: colors.textMuted, marginTop: 4 },
  rowAction: { padding: 4, flexShrink: 0 },
});
