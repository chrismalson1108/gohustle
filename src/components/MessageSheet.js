import React, { useState, useEffect, useRef } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, FlatList, Image,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { colors, shadows } from '../theme';
import { useHaptic } from '../hooks/useHaptic';
import { useJobs } from '../context/JobsContext';
import Avatar from './Avatar';
import { notify } from '../lib/push';
import { pickImage, uploadImage } from '../lib/uploadImage';
import { submitReport, REPORT_REASONS } from '../lib/moderation';
import { findProhibited } from '../lib/contentFilter';
import { markConversationRead } from '../lib/messages';

export default function MessageSheet({ visible, bookingId, jobTitle, otherPerson, onClose }) {
  const { user } = useAuth();
  const { blockUser, refreshUnread } = useJobs();
  const haptic = useHaptic();

  const otherName = otherPerson?.name || 'this user';

  const handleReport = () => {
    const buttons = REPORT_REASONS.map(reason => ({
      text: reason,
      onPress: async () => {
        try {
          await submitReport({ reporterId: user.id, reportedUserId: otherPerson?.id, bookingId, reason });
          Alert.alert('Report submitted', 'Thanks — our team will review this.');
        } catch (e) { Alert.alert('Could not submit', e.message || 'Please try again.'); }
      },
    }));
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert('Report ' + otherName, 'Why are you reporting this user?', buttons);
  };

  const handleBlock = () => {
    Alert.alert(`Block ${otherName}?`, "You won't see their gigs and they can't reach you here.", [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Block', style: 'destructive',
        onPress: async () => {
          try { await blockUser(otherPerson?.id); Alert.alert('Blocked', `${otherName} has been blocked.`); onClose?.(); }
          catch (e) { Alert.alert('Could not block', e.message || 'Please try again.'); }
        },
      },
    ]);
  };

  const handleMenu = () => {
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
    if (findProhibited(text)) {
      Alert.alert('Message blocked', "That message contains content that isn't allowed.");
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
      const detail = error.message || error.code || 'Unknown error';
      Alert.alert('Failed to send', `Your message could not be sent.\n\n${detail}\n\nPlease try again.`);
    } else {
      // Replace optimistic with confirmed message
      setMessages(prev => prev.map(m => m.id === tempId ? data : m));
      // Notify the other party of the new message
      if (otherPerson?.id) {
        notify(otherPerson.id, data.sender?.name ? `${data.sender.name}` : 'New message', text, { tab: 'MessagesTab' });
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
      const url = await uploadImage({ uri: picked.uri, bucket: 'chat-photos', userId: user.id });
      const { data, error } = await supabase
        .from('messages')
        .insert({ booking_id: bookingId, sender_id: user.id, text: '', image_url: url })
        .select('*, sender:profiles!sender_id(id, name, avatar_initial, avatar_url)')
        .single();
      if (error) throw error;
      setMessages(prev => [...prev, data]);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
      if (otherPerson?.id) notify(otherPerson.id, data.sender?.name || 'New message', '📷 Photo', { tab: 'MessagesTab' });
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
            <Image source={{ uri: item.image_url }} style={styles.msgImage} resizeMode="cover" />
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
              <View>
                <Text style={styles.headerTitle}>{otherPerson?.name || 'Chat'}</Text>
                {jobTitle && <Text style={styles.headerSub} numberOfLines={1}>re: {jobTitle}</Text>}
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
    </Modal>
  );
}

const styles = StyleSheet.create({
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
  headerTitle: { fontSize: 17, fontWeight: '800', color: colors.textPrimary },
  headerSub: { fontSize: 12, color: colors.textMuted, marginTop: 2, maxWidth: 260 },
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
