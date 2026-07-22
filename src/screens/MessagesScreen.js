import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import ScreenHeader from '../components/ScreenHeader';
import Avatar from '../components/Avatar';
import MessageSheet from '../components/MessageSheet';
import { useAuth } from '../context/AuthContext';
import { useJobs } from '../context/JobsContext';
import { useHaptic } from '../hooks/useHaptic';
import {
  fetchLastMessages, fetchConversationState, markConversationRead, setConversationArchived, isUnread, previewText, notBlocked,
} from '../lib/messages';
import { useTabBarScrollHandler } from '../lib/tabBarScroll';
import { colors, radii, shadows } from '../theme';

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const days = Math.floor((now - d) / 86400000);
  if (days < 7) return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function MessagesScreen({ navigation }) {
  const { user } = useAuth();
  const { bookings, posterBookings, jobs, refreshUnread, blockedIds } = useJobs();
  const haptic = useHaptic();
  const onTabBarScroll = useTabBarScrollHandler();
  const [convos, setConvos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState('inbox'); // 'inbox' | 'archived'
  const [activeChat, setActiveChat] = useState(null);

  const load = useCallback(async () => {
    if (!user) return;
    const ids = [...new Set([...bookings.map(b => b.id), ...posterBookings.map(b => b.id)])];
    const [last, st] = await Promise.all([fetchLastMessages(ids), fetchConversationState(user.id, ids)]);
    const list = ids.map(id => {
      const pb = posterBookings.find(b => b.id === id);
      const eb = bookings.find(b => b.id === id);
      let other = null, jobTitle = '', jobId = null;
      if (pb) {
        other = pb.earner ? { id: pb.earner.id, name: pb.earner.name, avatarInitial: pb.earner.avatarInitial, avatarUrl: pb.earner.avatarUrl } : null;
        jobTitle = pb.job?.title || '';
        jobId = pb.jobId;
      } else if (eb) {
        const job = jobs.find(j => j.id === eb.jobId);
        other = job?.poster ? { id: job.posterId, name: job.poster.name, avatarInitial: job.poster.avatarInitial, avatarUrl: job.poster.avatarUrl } : null;
        jobTitle = job?.title || eb.job?.title || '';
        jobId = eb.jobId;
      }
      return {
        bookingId: id, other, jobTitle, jobId,
        lastMsg: last[id], state: st[id],
        unread: isUnread(last[id], st[id], user.id),
        archived: !!st[id]?.archived,
      };
    }).filter(c => c.lastMsg && c.other && notBlocked(c, blockedIds));
    list.sort((a, b) => new Date(b.lastMsg.created_at) - new Date(a.lastMsg.created_at));
    setConvos(list);
    setLoading(false);
    refreshUnread?.();
  }, [user?.id, bookings, posterBookings, jobs, blockedIds]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const openChat = async (c) => {
    haptic.light();
    setActiveChat({
      bookingId: c.bookingId,
      jobId: c.jobId,
      jobTitle: c.jobTitle,
      otherPerson: c.other,
    });
    if (c.unread) {
      setConvos(prev => prev.map(x => x.bookingId === c.bookingId ? { ...x, unread: false } : x));
      try { await markConversationRead(user.id, c.bookingId); refreshUnread?.(); } catch (_) {}
    }
  };

  const toggleArchive = async (c) => {
    haptic.medium();
    setConvos(prev => prev.map(x => x.bookingId === c.bookingId ? { ...x, archived: !x.archived } : x));
    try { await setConversationArchived(user.id, c.bookingId, !c.archived); refreshUnread?.(); } catch (_) { load(); }
  };

  const shown = convos.filter(c => (tab === 'archived' ? c.archived : !c.archived));
  const inboxCount = convos.filter(c => !c.archived).length;
  const archivedCount = convos.filter(c => c.archived).length;

  return (
    <View style={styles.container}>
      <ScreenHeader>
        <View style={styles.headerRow}>
          <View style={styles.titleRow}>
            <Ionicons name="chatbubbles" size={22} color={colors.textPrimary} style={{ marginRight: 8 }} />
            <Text style={styles.title} numberOfLines={1}>Messages</Text>
          </View>
          <TouchableOpacity
            style={styles.headerAction}
            onPress={() => { haptic.light(); navigation.navigate('FindPeople'); }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Find people"
          >
            <Ionicons name="search" size={20} color={colors.textPrimary} />
          </TouchableOpacity>
        </View>
      </ScreenHeader>

      <View style={styles.segment}>
        <SegBtn label="Inbox" count={inboxCount} active={tab === 'inbox'} onPress={() => { haptic.selection(); setTab('inbox'); }} />
        <SegBtn label="Archived" count={archivedCount} active={tab === 'archived'} onPress={() => { haptic.selection(); setTab('archived'); }} />
      </View>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingTop: 4, paddingBottom: 140 }}
          onScroll={onTabBarScroll}
          scrollEventThrottle={32}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        >
          {shown.length === 0 ? (
            <View style={styles.empty}>
              <View style={styles.emptyIconWrap}>
                <Ionicons name="chatbubbles-outline" size={30} color={colors.textMuted} />
              </View>
              <Text style={styles.emptyTitle}>{tab === 'archived' ? 'No archived chats' : 'No messages yet'}</Text>
              <Text style={styles.emptyText}>
                {tab === 'archived' ? 'Archived conversations show up here.' : 'Message a poster or earner from a gig to start a conversation.'}
              </Text>
            </View>
          ) : shown.map(c => (
            <TouchableOpacity key={c.bookingId} style={styles.row} onPress={() => openChat(c)} activeOpacity={0.85}>
              {/* Avatar is its own tap target → the person's public profile. */}
              <TouchableOpacity
                onPress={() => { haptic.light(); navigation.navigate('UserProfile', { userId: c.other.id }); }}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                accessibilityLabel={`View ${c.other.name || 'user'}'s profile`}
              >
                <Avatar url={c.other.avatarUrl} initial={c.other.avatarInitial || c.other.name?.[0]} size={48} fontSize={18} style={{ marginRight: 12 }} />
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <View style={styles.rowTop}>
                  <Text style={[styles.name, c.unread && styles.unreadText]} numberOfLines={1}>{c.other.name || 'User'}</Text>
                  <View style={styles.rowMeta}>
                    {c.unread && <View style={styles.unreadDot} />}
                    <Text style={[styles.time, c.unread && styles.timeUnread]} numberOfLines={1}>{timeLabel(c.lastMsg.created_at)}</Text>
                  </View>
                </View>
                {c.jobTitle ? <Text style={styles.jobTitle} numberOfLines={1}>re: {c.jobTitle}</Text> : null}
                <Text style={[styles.preview, c.unread && styles.previewUnread]} numberOfLines={1}>
                  {c.lastMsg.sender_id === user.id ? 'You: ' : ''}{previewText(c.lastMsg)}
                </Text>
              </View>
              <View style={styles.rowRight}>
                <TouchableOpacity onPress={() => toggleArchive(c)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={styles.archiveBtn}>
                  <Ionicons name={c.archived ? 'arrow-undo-outline' : 'archive-outline'} size={18} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      <MessageSheet
        visible={!!activeChat}
        bookingId={activeChat?.bookingId}
        jobId={activeChat?.jobId}
        jobTitle={activeChat?.jobTitle}
        otherPerson={activeChat?.otherPerson}
        onClose={() => { setActiveChat(null); load(); }}
        onViewProfile={(userId) => { setActiveChat(null); navigation.navigate('UserProfile', { userId }); }}
        onViewJob={(jobId) => { setActiveChat(null); navigation.navigate('JobDetail', { jobId }); }}
      />
    </View>
  );
}

function SegBtn({ label, count, active, onPress }) {
  return (
    <TouchableOpacity style={[styles.segBtn, active && styles.segBtnActive]} onPress={onPress} activeOpacity={0.8}>
      <Text style={[styles.segText, active && styles.segTextActive]} numberOfLines={1}>
        {label}
        {count > 0 ? <Text style={styles.segCount}>{`  ${count}`}</Text> : null}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  titleRow: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, marginRight: 12 },
  title: {
    fontSize: 24, fontWeight: '700', color: colors.textPrimary,
    letterSpacing: -0.4, flexShrink: 1,
  },
  headerAction: {
    width: 40, height: 40, borderRadius: radii.pill,
    backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },

  segment: {
    flexDirection: 'row', marginHorizontal: 20, marginTop: 12,
    backgroundColor: colors.surface, borderRadius: radii.pill, padding: 4,
    borderWidth: 1, borderColor: colors.border,
  },
  segBtn: { flex: 1, paddingVertical: 10, paddingHorizontal: 8, alignItems: 'center', borderRadius: radii.pill },
  segBtnActive: { backgroundColor: colors.primary },
  segText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, flexShrink: 1 },
  segTextActive: { color: '#fff' },
  segCount: { fontWeight: '500' },

  empty: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 56 },
  emptyIconWrap: {
    width: 72, height: 72, borderRadius: radii.pill, backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18, fontWeight: '700', color: colors.textPrimary,
    marginBottom: 8, textAlign: 'center', lineHeight: 24,
  },
  emptyText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 21 },

  row: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    marginHorizontal: 20, marginTop: 8, borderRadius: radii.lg,
    paddingVertical: 14, paddingHorizontal: 16,
    ...shadows.card,
  },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowMeta: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  name: { fontSize: 15, fontWeight: '600', color: colors.textPrimary, flexShrink: 1, marginRight: 8 },
  unreadText: { fontWeight: '700', color: colors.textPrimary },
  time: { fontSize: 11, color: colors.textMuted, lineHeight: 15 },
  timeUnread: { color: colors.primary, fontWeight: '600' },
  jobTitle: { fontSize: 12, color: colors.textMuted, marginTop: 4, lineHeight: 16 },
  preview: { fontSize: 13, color: colors.textSecondary, marginTop: 4, lineHeight: 18 },
  previewUnread: { fontWeight: '600', color: colors.textPrimary },
  rowRight: { alignItems: 'center', justifyContent: 'center', marginLeft: 8, flexShrink: 0 },
  archiveBtn: { padding: 6 },
  unreadDot: { width: 8, height: 8, borderRadius: radii.pill, backgroundColor: colors.primary, marginRight: 6 },
});
