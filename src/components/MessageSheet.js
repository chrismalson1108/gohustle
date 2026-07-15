import React, { useState, useEffect, useRef } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, FlatList, Image,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useUser } from '../context/UserContext';
import { colors, shadows } from '../theme';
import { useHaptic } from '../hooks/useHaptic';
import { useJobs } from '../context/JobsContext';
import { captureError } from '../lib/analytics';
import Avatar from './Avatar';
import { notify } from '../lib/push';
import { pickImage, uploadPrivateImage, getSignedUrl } from '../lib/uploadImage';
import { submitReport, REPORT_REASONS } from '../lib/moderation';
import { findProhibited } from '../lib/contentFilter';
import { moderateText, logModerationBlock } from '../lib/moderation';
import { markConversationRead } from '../lib/messages';

// Optional navigation hooks: `onViewProfile(userId)` makes the header person
// tappable, `onViewJob(jobId)` (with `jobId`) makes the "re: job" line tappable.
// Callers are responsible for closing the sheet before navigating.
export default function MessageSheet({ visible, bookingId, jobId, jobTitle, otherPerson, onClose, onViewProfile, onViewJob }) {
  const { user } = useAuth();
  const { blockUser, refreshUnread } = useJobs();
  const { showToast } = useUser();
  const haptic = useHaptic();

  const otherName = otherPerson?.name || 'this user';

  // react-native-web's Alert.alert buttons are a no-op, so any Alert-gated confirm is
  // unreachable on the Expo web build. Use the browser's confirm() there instead.
  const webConfirm = (message) =>
    typeof window !== 'undefined' && typeof window.confirm === 'function' && window.confirm(message);

  // Report reasons are shown in a Modal, not Alert.alert: Android caps alerts at 3
  // buttons, so a 5-reason + Cancel list was truncated and trapped the user.
  const handleReport = () => setReportVisible(true);
  const submitReportReason = async (reason) => {
    setReportVisible(false);
    try {
      await submitReport({ reporterId: user.id, reportedUserId: otherPerson?.id, bookingId, reason });
      showToast?.({ icon: '✅', title: 'Report submitted', message: 'Thanks — our team will review this.' });
    } catch (e) {
      showToast?.({ icon: '⚠️', title: 'Could not submit', message: e.message || 'Please try again.' });
    }
  };

  const doBlock = async () => {
    try {
      await blockUser(otherPerson?.id);
      showToast?.({ icon: '🚫', title: 'Blocked', message: `${otherName} has been blocked.` });
      onClose?.();
    } catch (e) {
      showToast?.({ icon: '⚠️', title: 'Could not block', message: e.message || 'Please try again.' });
    }
  };

  const handleBlock = () => {
    const body = "You won't see their gigs, and they won't be able to message or book you.";
    if (Platform.OS === 'web') { if (webConfirm(`Block ${otherName}?\n\n${body}`)) doBlock(); return; }
    Alert.alert(`Block ${otherName}?`, body, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Block', style: 'destructive', onPress: doBlock },
    ]);
  };

  const handleMenu = () => {
    // Alert action-sheet buttons are a no-op on react-native-web; fall back to
    // confirm() so Report/Block stay reachable on the web build.
    if (Platform.OS === 'web') {
      if (webConfirm(`Report ${otherName}?\n\nOK to report, Cancel for other options.`)) { handleReport(); return; }
      handleBlock();
      return;
    }
    Alert.alert(otherName, undefined, [
      { text: 'Report', onPress: handleReport },
      { text: 'Block', style: 'destructive', onPress: handleBlock },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploadingImg, setUploadingImg] = useState(false);
  // chat-photos is a private bucket — resolve each image message to a short-lived
  // signed URL (keyed by object path) instead of a permanent public URL.
  const [signedUrls, setSignedUrls] = useState({});
  const [reportVisible, setReportVisible] = useState(false);
  const listRef = useRef(null);
  const userIdRef = useRef(user?.id);
  userIdRef.current = user?.id;

  useEffect(() => {
    if (!visible || !bookingId) { setMessages([]); return; }
    loadMessages();
    // Opening a chat marks it read (clears the Messages unread badge).
    if (user?.id) markConversationRead(user.id, bookingId).then(() => refreshUnread?.()).catch(() => {});
    const cleanup = setupRealtime();
    return cleanup;
  }, [visible, bookingId]);

  // A chat image_url is a bare object path ("<uid>/<file>", new rows) or a legacy
  // full public URL ending in "/chat-photos/<uid>/<file>". Return the object path.
  const chatObjectPath = (stored) => {
    if (!stored) return null;
    const i = stored.indexOf('/chat-photos/');
    return i >= 0 ? stored.slice(i + '/chat-photos/'.length) : stored;
  };

  // Sign any image messages we haven't signed yet.
  useEffect(() => {
    let active = true;
    const paths = [...new Set(
      messages.map(m => chatObjectPath(m.image_url)).filter(p => p && !signedUrls[p] && !p.startsWith('file:') && !p.startsWith('http'))
    )];
    if (!paths.length) return;
    (async () => {
      const entries = await Promise.all(paths.map(async p => [p, await getSignedUrl('chat-photos', p)]));
      if (!active) return;
      setSignedUrls(prev => {
        const next = { ...prev };
        for (const [p, url] of entries) if (url) next[p] = url;
        return next;
      });
    })();
    return () => { active = false; };
  }, [messages]);

  const loadMessages = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('messages')
      .select('*, sender:profiles!sender_id(id, name, avatar_initial, avatar_url)')
      .eq('booking_id', bookingId)
      .order('created_at', { ascending: true });
    if (data) setMessages(data);
    setLoading(false);
    setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
  };

  const setupRealtime = () => {
    const channel = supabase.channel(`msgs-${bookingId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `booking_id=eq.${bookingId}`,
      }, async (payload) => {
        // Skip own messages — already added optimistically
        if (payload.new.sender_id === userIdRef.current) return;
        const { data: sender } = await supabase
          .from('profiles')
          .select('id, name, avatar_initial, avatar_url')
          .eq('id', payload.new.sender_id)
          .single();
        setMessages(prev => [...prev, { ...payload.new, sender }]);
        setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  };

  const sendMessage = async () => {
    const text = inputText.trim();
    if (!text || !bookingId || !user) return;
    const kwTerm = findProhibited(text);
    if (kwTerm) {
      logModerationBlock(kwTerm, 'message', text, bookingId);
      showToast?.({ icon: '🚫', title: 'Message blocked', message: "That message contains content that isn't allowed." });
      return;
    }
    // Context-aware check (harassment, threats, scams a keyword list misses).
    setSending(true);
    const mod = await moderateText(text, 'message', bookingId);
    setSending(false);
    if (!mod.allowed) {
      showToast?.({ icon: '🚫', title: 'Message blocked', message: "That message contains content that isn't allowed." });
      return;
    }

    // Optimistic insert
    const tempId = `temp-${Date.now()}`;
    const optimistic = {
      id: tempId,
      booking_id: bookingId,
      sender_id: user.id,
      text,
      created_at: new Date().toISOString(),
      sender: { id: user.id },
      _pending: true,
    };
    setMessages(prev => [...prev, optimistic]);
    setInputText('');
    haptic.light();
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);

    setSending(true);
    const { data, error } = await supabase
      .from('messages')
      .insert({ booking_id: bookingId, sender_id: user.id, text })
      .select('*, sender:profiles!sender_id(id, name, avatar_initial, avatar_url)')
      .single();
    setSending(false);

    if (error) {
      // Remove optimistic message and restore input
      setMessages(prev => prev.filter(m => m.id !== tempId));
      setInputText(text);
      // Never surface raw RLS/DB text: a block-enforcement rejection returns a
      // distinctive "row-level security" error (a block-oracle the block migration
      // deliberately avoided), and inviting "try again" loops on a hard rejection
      // looks broken. Map known shapes; keep the age-floor message (user-facing by
      // design) verbatim; log the raw detail for debugging instead of showing it.
      captureError(error, { where: 'MessageSheet.sendMessage', bookingId });
      const raw = error.message || '';
      const isRls = error.code === '42501' || /row-level security/i.test(raw);
      const isAgeFloor = /18 or older/i.test(raw);
      const message = isRls
        ? "Your message couldn't be sent."
        : isAgeFloor
          ? raw
          : "Your message couldn't be sent. Please try again.";
      showToast?.({ icon: '⚠️', title: 'Not sent', message });
    } else {
      // Replace optimistic with confirmed message
      setMessages(prev => prev.map(m => m.id === tempId ? data : m));
      // Notify the other party of the new message
      if (otherPerson?.id) {
        notify(otherPerson.id, data.sender?.name ? `${data.sender.name}` : 'New message', text, { tab: 'MessagesTab', type: 'message' });
      }
    }
  };

  const sendImage = async () => {
    if (!bookingId || !user) return;
    const picked = await pickImage({});
    if (picked.canceled) {
      if (picked.denied) Alert.alert('Photos access needed', 'Allow photo access in Settings to send images.');
      return;
    }
    setUploadingImg(true);
    haptic.light();
    try {
      const path = await uploadPrivateImage({ uri: picked.uri, bucket: 'chat-photos', userId: user.id });
      const { data, error } = await supabase
        .from('messages')
        .insert({ booking_id: bookingId, sender_id: user.id, text: '', image_url: path })
        .select('*, sender:profiles!sender_id(id, name, avatar_initial, avatar_url)')
        .single();
      if (error) throw error;
      // Seed the signed URL so the sender sees their photo immediately (private bucket).
      const signed = await getSignedUrl('chat-photos', path);
      if (signed) setSignedUrls(prev => ({ ...prev, [path]: signed }));
      setMessages(prev => [...prev, data]);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
      if (otherPerson?.id) notify(otherPerson.id, data.sender?.name || 'New message', '📷 Photo', { tab: 'MessagesTab', type: 'message' });
    } catch (e) {
      Alert.alert('Failed to send photo', e.message || 'Please try again.');
    }
    setUploadingImg(false);
  };

  const renderMessage = ({ item }) => {
    const isMine = item.sender_id === user?.id;
    const time = new Date(item.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return (
      <View style={[styles.msgRow, isMine && styles.msgRowMine]}>
        {!isMine && (
          <Avatar
            url={item.sender?.avatar_url || otherPerson?.avatarUrl}
            initial={item.sender?.avatar_initial || otherPerson?.avatarInitial}
            size={28}
            fontSize={11}
            style={{ marginRight: 8, marginBottom: 2 }}
          />
        )}
        <View style={[styles.msgBubble, isMine && styles.msgBubbleMine, item._pending && styles.msgBubblePending]}>
          {item.image_url ? (
            (() => {
              const p = chatObjectPath(item.image_url);
              const uri = signedUrls[p] || (p && (p.startsWith('http') || p.startsWith('file:')) ? p : null);
              return uri
                ? <Image source={{ uri }} style={styles.msgImage} resizeMode="cover" />
                : <View style={[styles.msgImage, { alignItems: 'center', justifyContent: 'center' }]}><ActivityIndicator color={colors.primary} /></View>;
            })()
          ) : null}
          {item.text ? (
            <Text style={[styles.msgText, isMine && styles.msgTextMine]}>{item.text}</Text>
          ) : null}
          <Text style={[styles.msgTime, isMine && styles.msgTimeMine]}>
            {item._pending ? 'Sending…' : time}
          </Text>
        </View>
      </View>
    );
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.handle} />
            <View style={styles.headerContent}>
              <View style={{ flex: 1, marginRight: 8 }}>
                <TouchableOpacity
                  style={styles.headerPerson}
                  disabled={!onViewProfile || !otherPerson?.id}
                  onPress={() => onViewProfile?.(otherPerson.id)}
                  activeOpacity={0.7}
                >
                  <Avatar url={otherPerson?.avatarUrl} initial={otherPerson?.avatarInitial || otherPerson?.name?.[0]} size={28} fontSize={12} style={{ marginRight: 8 }} />
                  <Text style={styles.headerTitle} numberOfLines={1}>{otherPerson?.name || 'Chat'}</Text>
                  {onViewProfile && otherPerson?.id ? <Ionicons name="chevron-forward" size={14} color={colors.textMuted} style={{ marginLeft: 2 }} /> : null}
                </TouchableOpacity>
                {jobTitle ? (
                  <TouchableOpacity
                    disabled={!onViewJob || !jobId}
                    onPress={() => onViewJob?.(jobId)}
                    activeOpacity={0.7}
                    style={{ flexDirection: 'row', alignItems: 'center' }}
                  >
                    <Text style={[styles.headerSub, onViewJob && jobId ? styles.headerSubLink : null]} numberOfLines={1}>
                      re: {jobTitle}
                    </Text>
                    {onViewJob && jobId ? <Ionicons name="open-outline" size={12} color={colors.primary} style={{ marginLeft: 4, marginTop: 2 }} /> : null}
                  </TouchableOpacity>
                ) : null}
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {otherPerson?.id && (
                  <TouchableOpacity onPress={handleMenu} style={styles.closeBtn}>
                    <Ionicons name="ellipsis-horizontal" size={20} color={colors.textMuted} />
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                  <Ionicons name="close" size={20} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
            </View>
          </View>

          {loading ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : (
            <FlatList
              ref={listRef}
              data={messages}
              keyExtractor={m => m.id}
              renderItem={renderMessage}
              contentContainerStyle={styles.msgList}
              ListEmptyComponent={
                <View style={styles.emptyChat}>
                  <Ionicons name="chatbubble-ellipses" size={48} color={colors.textMuted} style={styles.emptyChatIcon} />
                  <Text style={styles.emptyChatText}>
                    No messages yet.{'\n'}Say hi to {otherPerson?.name || 'them'}!
                  </Text>
                </View>
              }
            />
          )}

          <View style={styles.inputRow}>
            <TouchableOpacity
              style={styles.attachBtn}
              onPress={sendImage}
              disabled={uploadingImg}
            >
              {uploadingImg
                ? <ActivityIndicator color={colors.primary} size="small" />
                : <Ionicons name="image-outline" size={22} color={colors.primary} />}
            </TouchableOpacity>
            <TextInput
              style={styles.input}
              placeholder="Type a message..."
              placeholderTextColor={colors.textMuted}
              value={inputText}
              onChangeText={setInputText}
              multiline
              maxLength={500}
              returnKeyType="send"
              blurOnSubmit={false}
              onSubmitEditing={sendMessage}
            />
            <TouchableOpacity
              style={[styles.sendBtn, (!inputText.trim() || sending) && styles.sendBtnDisabled]}
              onPress={sendMessage}
              disabled={!inputText.trim() || sending}
            >
              {sending
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={styles.sendIcon}>↑</Text>
              }
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* Report-reason picker — a real modal so all reasons show on Android too. */}
      <Modal visible={reportVisible} animationType="fade" transparent onRequestClose={() => setReportVisible(false)}>
        <TouchableOpacity style={styles.reportOverlay} activeOpacity={1} onPress={() => setReportVisible(false)}>
          <View style={styles.reportCard}>
            <Text style={styles.reportTitle}>Report {otherName}</Text>
            <Text style={styles.reportSub}>Why are you reporting this user?</Text>
            {REPORT_REASONS.map((reason) => (
              <TouchableOpacity key={reason} style={styles.reportRow} onPress={() => submitReportReason(reason)}>
                <Text style={styles.reportRowText}>{reason}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={styles.reportCancel} onPress={() => setReportVisible(false)}>
              <Text style={styles.reportCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </Modal>
  );
}

const styles = StyleSheet.create({
  reportOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  reportCard: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 32 },
  reportTitle: { fontSize: 17, fontWeight: '800', color: colors.textPrimary },
  reportSub: { fontSize: 13, color: colors.textSecondary, marginTop: 2, marginBottom: 12 },
  reportRow: { paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.border },
  reportRowText: { fontSize: 15, color: colors.textPrimary, fontWeight: '600' },
  reportCancel: { marginTop: 12, paddingVertical: 14, alignItems: 'center', borderRadius: 12, backgroundColor: colors.background },
  reportCancelText: { fontSize: 15, color: colors.textSecondary, fontWeight: '700' },
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    height: '75%', ...shadows.md,
  },
  header: { paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  handle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border,
    alignSelf: 'center', marginTop: 12, marginBottom: 14,
  },
  headerContent: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  headerPerson: { flexDirection: 'row', alignItems: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '800', color: colors.textPrimary, flexShrink: 1 },
  headerSub: { fontSize: 12, color: colors.textMuted, marginTop: 2, maxWidth: 260 },
  headerSubLink: { color: colors.primary, fontWeight: '600' },
  closeBtn: { padding: 4 },
  closeBtnText: { fontSize: 17, color: colors.textMuted, fontWeight: '700' },
  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  msgList: { paddingHorizontal: 16, paddingVertical: 12, flexGrow: 1 },
  msgRow: { flexDirection: 'row', marginBottom: 12, alignItems: 'flex-end' },
  msgRowMine: { justifyContent: 'flex-end' },
  msgAvatar: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    marginRight: 8, marginBottom: 2,
  },
  msgAvatarText: { color: '#fff', fontSize: 11, fontWeight: '900' },
  msgBubble: {
    backgroundColor: colors.background, borderRadius: 18, borderBottomLeftRadius: 4,
    paddingHorizontal: 14, paddingVertical: 9, maxWidth: '75%',
  },
  msgBubbleMine: { backgroundColor: colors.primary, borderBottomLeftRadius: 18, borderBottomRightRadius: 4 },
  msgBubblePending: { opacity: 0.6 },
  msgText: { fontSize: 14, color: colors.textPrimary, lineHeight: 20 },
  msgTextMine: { color: '#fff' },
  msgImage: { width: 200, height: 200, borderRadius: 12, marginBottom: 4, backgroundColor: colors.border },
  msgTime: { fontSize: 10, color: colors.textMuted, marginTop: 4, alignSelf: 'flex-end' },
  msgTimeMine: { color: 'rgba(255,255,255,0.6)' },
  emptyChat: { flex: 1, alignItems: 'center', paddingTop: 40 },
  emptyChatIcon: { fontSize: 40, marginBottom: 12 },
  emptyChatText: { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 22 },
  inputRow: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 16, paddingVertical: 12,
    borderTopWidth: 1, borderTopColor: colors.border,
    paddingBottom: Platform.OS === 'ios' ? 28 : 16,
  },
  attachBtn: {
    width: 42, height: 42, borderRadius: 21,
    alignItems: 'center', justifyContent: 'center', marginRight: 6,
  },
  input: {
    flex: 1, backgroundColor: colors.background, borderRadius: 22,
    borderWidth: 1.5, borderColor: colors.border,
    paddingHorizontal: 16, paddingVertical: 10,
    fontSize: 14, color: colors.textPrimary, maxHeight: 100,
    marginRight: 10,
  },
  sendBtn: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: colors.border },
  sendIcon: { color: '#fff', fontSize: 18, fontWeight: '900', lineHeight: 22 },
});
