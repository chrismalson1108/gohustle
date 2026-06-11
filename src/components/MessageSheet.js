import React, { useState, useEffect, useRef } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { colors, shadows } from '../theme';
import { useHaptic } from '../hooks/useHaptic';

export default function MessageSheet({ visible, bookingId, jobTitle, otherPerson, onClose }) {
  const { user } = useAuth();
  const haptic = useHaptic();
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);

  useEffect(() => {
    if (!visible || !bookingId) { setMessages([]); return; }
    loadMessages();
    const cleanup = setupRealtime();
    return cleanup;
  }, [visible, bookingId]);

  const loadMessages = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('messages')
      .select('*, sender:profiles!sender_id(id, name, avatar_initial)')
      .eq('booking_id', bookingId)
      .order('created_at', { ascending: true });
    if (data) setMessages(data);
    setLoading(false);
    scrollToBottom();
  };

  const setupRealtime = () => {
    const channel = supabase.channel(`msgs-${bookingId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `booking_id=eq.${bookingId}`,
      }, async (payload) => {
        const { data: sender } = await supabase
          .from('profiles')
          .select('id, name, avatar_initial')
          .eq('id', payload.new.sender_id)
          .single();
        setMessages(prev => [...prev, { ...payload.new, sender }]);
        scrollToBottom();
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  };

  const scrollToBottom = () => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
  };

  const sendMessage = async () => {
    const text = inputText.trim();
    if (!text || !bookingId || !user) return;
    setSending(true);
    setInputText('');
    haptic.light();
    const { error } = await supabase.from('messages').insert({
      booking_id: bookingId,
      sender_id: user.id,
      text,
    });
    if (error) console.warn('Send error:', error.message);
    setSending(false);
  };

  const renderMessage = ({ item }) => {
    const isMine = item.sender_id === user?.id;
    const time = new Date(item.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return (
      <View style={[styles.msgRow, isMine && styles.msgRowMine]}>
        {!isMine && (
          <View style={styles.msgAvatar}>
            <Text style={styles.msgAvatarText}>
              {item.sender?.avatar_initial || otherPerson?.avatarInitial || '?'}
            </Text>
          </View>
        )}
        <View style={[styles.msgBubble, isMine && styles.msgBubbleMine]}>
          <Text style={[styles.msgText, isMine && styles.msgTextMine]}>{item.text}</Text>
          <Text style={[styles.msgTime, isMine && styles.msgTimeMine]}>{time}</Text>
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
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.handle} />
            <View style={styles.headerContent}>
              <View>
                <Text style={styles.headerTitle}>
                  {otherPerson?.name || 'Chat'}
                </Text>
                {jobTitle && (
                  <Text style={styles.headerSub} numberOfLines={1}>re: {jobTitle}</Text>
                )}
              </View>
              <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                <Text style={styles.closeBtnText}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Messages */}
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
              onContentSizeChange={scrollToBottom}
              ListEmptyComponent={
                <View style={styles.emptyChat}>
                  <Text style={styles.emptyChatIcon}>💬</Text>
                  <Text style={styles.emptyChatText}>
                    No messages yet.{'\n'}Say hi to {otherPerson?.name || 'them'}!
                  </Text>
                </View>
              }
            />
          )}

          {/* Input */}
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              placeholder="Type a message..."
              placeholderTextColor={colors.textMuted}
              value={inputText}
              onChangeText={setInputText}
              multiline
              maxLength={500}
              returnKeyType="send"
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
  msgBubbleMine: {
    backgroundColor: colors.primary, borderBottomLeftRadius: 18, borderBottomRightRadius: 4,
  },
  msgText: { fontSize: 14, color: colors.textPrimary, lineHeight: 20 },
  msgTextMine: { color: '#fff' },
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
