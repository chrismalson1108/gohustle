import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Modal, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { askAssistant } from '../lib/assistantClient';
import { listThreads, loadThread, deleteThread } from '../lib/assistantThreads';
import { useJobs } from '../context/JobsContext';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import { colors, shadows } from '../theme';

const GREETING =
  "Hey! I'm Hustlr AI 👋 I can find gigs for you, post a gig (just describe it — tap the 🎤 on your keyboard to talk), book work, and check how you're doing. What do you need?";

const SUGGESTIONS = [
  'Find me a gig this weekend',
  'Post a gig for me',
  'Recommend gigs for my skills',
  'How am I doing?',
];

export default function AssistantButton() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [threadId, setThreadId] = useState(null);
  const [view, setView] = useState('chat'); // 'chat' | 'history'
  const [threads, setThreads] = useState([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);
  const haptic = useHaptic();
  const insets = useSafeAreaInsets();

  const { refreshJobs, refreshBookings, refreshPosterBookings } = useJobs();
  const { refreshProfile, showToast } = useUser();

  // Greet a fresh chat only — not when reopening a saved thread.
  useEffect(() => {
    if (open && messages.length === 0 && threadId === null) {
      setMessages([{ role: 'assistant', content: GREETING }]);
    }
  }, [open, messages.length, threadId]);

  useEffect(() => {
    if (scrollRef.current) setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
  }, [messages, busy]);

  const runActions = (actions = []) => {
    const kinds = new Set(actions.map((a) => a.type));
    if (kinds.has('gig_created')) {
      refreshJobs?.();
      refreshPosterBookings?.();
      showToast?.({ icon: '📣', title: 'Gig posted!', message: 'Hustlr AI created your gig.' });
    }
    if (kinds.has('gig_booked')) {
      refreshJobs?.();
      refreshBookings?.();
      showToast?.({ icon: '✅', title: 'Booked!', message: 'Hustlr AI sent your request.' });
    }
    if (kinds.has('profile_updated')) refreshProfile?.();
  };

  const send = async (text) => {
    const trimmed = (text || '').trim();
    if (!trimmed || busy) return;
    haptic?.light?.();
    setInput('');
    setError(null);
    const next = [...messages, { role: 'user', content: trimmed }];
    setMessages(next);
    setBusy(true);
    try {
      // The synthetic greeting bubble is render-only — don't feed it to the model.
      const payload = next[0]?.role === 'assistant' && next[0].content === GREETING ? next.slice(1) : next;
      const res = await askAssistant(payload, { threadId, newThread: !threadId });
      setMessages([...next, { role: 'assistant', content: res.reply }]);
      if (res.thread_id) setThreadId(res.thread_id);
      runActions(res.actions);
    } catch (err) {
      setError(err.message || 'Hustlr AI is unavailable right now. Try again.');
    } finally {
      setBusy(false);
    }
  };

  // Context-switching actions — blocked mid-send so an in-flight reply can't
  // clobber the new view (and the buttons are disabled while busy).
  const newChat = () => {
    if (busy) return;
    setError(null);
    setThreadId(null);
    setMessages([{ role: 'assistant', content: GREETING }]);
    setView('chat');
  };

  const openHistory = async () => {
    if (busy) return;
    setView('history');
    setLoadingThreads(true);
    try { setThreads(await listThreads()); } catch { setThreads([]); }
    setLoadingThreads(false);
  };

  const pickThread = async (t) => {
    if (busy) return;
    try {
      const msgs = await loadThread(t.id);
      setThreadId(t.id);
      setMessages(msgs.map((m) => ({ role: m.role, content: m.content })));
      setError(null);
      setView('chat');
    } catch {
      setError("Couldn't open that conversation — try again.");
    }
  };

  const removeThread = async (id) => {
    if (busy) return;
    try {
      await deleteThread(id);
      setThreads((ts) => ts.filter((t) => t.id !== id));
      if (id === threadId) newChat();
    } catch {
      setError("Couldn't delete that conversation.");
    }
  };

  return (
    <>
      {/* Floating launcher — sits above the floating pill tab bar */}
      <TouchableOpacity
        style={[styles.fab, { bottom: Math.max(insets.bottom, 16) + 78 }]}
        onPress={() => { haptic?.light?.(); setOpen(true); }}
        activeOpacity={0.85}
        accessibilityLabel="Open Hustlr AI assistant"
      >
        <Ionicons name="sparkles" size={26} color="#fff" />
      </TouchableOpacity>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={styles.modal}>
          <StatusBar style="light" />
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
            {/* Header */}
            <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
              <View style={styles.headerIcon}>
                <Ionicons name="sparkles" size={20} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.headerTitle}>Hustlr AI</Text>
                <Text style={styles.headerSub}>Your gig sidekick</Text>
              </View>
              <TouchableOpacity onPress={newChat} disabled={busy} accessibilityLabel="New chat" style={[styles.headerBtn, busy && { opacity: 0.4 }]}>
                <Ionicons name="add" size={24} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity onPress={openHistory} disabled={busy} accessibilityLabel="Past conversations" style={[styles.headerBtn, busy && { opacity: 0.4 }]}>
                <Ionicons name="time-outline" size={23} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setOpen(false)} accessibilityLabel="Close" style={styles.headerBtn}>
                <Ionicons name="close" size={26} color="#fff" />
              </TouchableOpacity>
            </View>

            {view === 'history' ? (
              <HistoryPanel
                threads={threads}
                loading={loadingThreads}
                activeId={threadId}
                onBack={() => setView('chat')}
                onPick={pickThread}
                onDelete={removeThread}
              />
            ) : (
              <>
                {/* Messages */}
                <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={{ padding: 14, gap: 10 }}>
                  {messages.map((m, i) => (
                    <Bubble key={i} role={m.role} content={m.content} />
                  ))}
                  {busy && (
                    <View style={styles.thinking}>
                      <ActivityIndicator size="small" color={colors.primary} />
                      <Text style={styles.thinkingText}>Thinking…</Text>
                    </View>
                  )}
                  {messages.length <= 1 && !busy && (
                    <View style={styles.chips}>
                      {SUGGESTIONS.map((s) => (
                        <TouchableOpacity key={s} style={styles.chip} onPress={() => send(s)}>
                          <Text style={styles.chipText}>{s}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </ScrollView>

                {/* Composer */}
                {error ? <Text style={styles.errorText}>{error}</Text> : null}
                <View style={[styles.composer, { paddingBottom: insets.bottom + 10 }]}>
                  <TextInput
                    style={styles.input}
                    value={input}
                    onChangeText={setInput}
                    placeholder="Ask anything, or describe a gig…"
                    placeholderTextColor={colors.textMuted}
                    multiline
                    onSubmitEditing={() => send(input)}
                  />
                  <TouchableOpacity
                    style={[styles.sendBtn, (!input.trim() || busy) && { opacity: 0.4 }]}
                    onPress={() => send(input)}
                    disabled={!input.trim() || busy}
                    accessibilityLabel="Send"
                  >
                    <Ionicons name="send" size={20} color="#fff" />
                  </TouchableOpacity>
                </View>
              </>
            )}
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </>
  );
}

function Bubble({ role, content }) {
  const isUser = role === 'user';
  return (
    <View style={[styles.bubbleRow, { justifyContent: isUser ? 'flex-end' : 'flex-start' }]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleBot]}>
        {renderRich(content, isUser)}
      </View>
    </View>
  );
}

// Light markdown: **bold** + lines starting with "- "/"•" as bullets.
function renderRich(text, isUser) {
  const color = isUser ? '#fff' : colors.textPrimary;
  return String(text).split('\n').map((line, i) => {
    const bullet = /^\s*[-•]\s+/.test(line);
    const body = bullet ? line.replace(/^\s*[-•]\s+/, '') : line;
    const segs = body.split(/(\*\*[^*]+\*\*)/g).map((seg, j) =>
      seg.startsWith('**') && seg.endsWith('**')
        ? <Text key={j} style={{ fontWeight: '800' }}>{seg.slice(2, -2)}</Text>
        : <Text key={j}>{seg}</Text>,
    );
    return (
      <Text key={i} style={{ color, fontSize: 14.5, lineHeight: 21, flexDirection: 'row' }}>
        {bullet ? '•  ' : ''}{segs}
      </Text>
    );
  });
}

function HistoryPanel({ threads, loading, activeId, onBack, onPick, onDelete }) {
  return (
    <View style={styles.histPanel}>
      <TouchableOpacity onPress={onBack} style={styles.histBack}>
        <Ionicons name="arrow-back" size={18} color={colors.primary} />
        <Text style={styles.histBackText}>Back to chat</Text>
      </TouchableOpacity>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 6 }}>
        {loading ? (
          <View style={styles.thinking}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.thinkingText}>Loading…</Text>
          </View>
        ) : threads.length === 0 ? (
          <Text style={styles.histEmpty}>No past conversations yet.</Text>
        ) : (
          threads.map((t) => (
            <View key={t.id} style={[styles.histRow, t.id === activeId && styles.histRowActive]}>
              <TouchableOpacity style={{ flex: 1 }} onPress={() => onPick(t)}>
                <Text style={styles.histTitle} numberOfLines={1}>{t.title || 'Conversation'}</Text>
                <Text style={styles.histTime}>{relTime(t.updated_at)}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => onDelete(t.id)} style={styles.histDelete} accessibilityLabel="Delete conversation">
                <Ionicons name="trash-outline" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

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

const styles = StyleSheet.create({
  fab: {
    position: 'absolute', right: 16, width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', ...shadows.md,
  },
  modal: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: colors.primary,
  },
  headerIcon: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '900' },
  headerSub: { color: 'rgba(255,255,255,0.8)', fontSize: 12 },
  scroll: { flex: 1, backgroundColor: colors.background },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  thinkingText: { color: colors.textMuted, fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4 },
  chip: {
    borderWidth: 1, borderColor: colors.border, backgroundColor: '#fff', borderRadius: 999,
    paddingHorizontal: 12, paddingVertical: 7,
  },
  chipText: { fontSize: 12.5, fontWeight: '700', color: colors.textSecondary },
  bubbleRow: { flexDirection: 'row' },
  bubble: { maxWidth: '86%', borderRadius: 18, paddingHorizontal: 13, paddingVertical: 9 },
  bubbleUser: { backgroundColor: colors.primary, borderBottomRightRadius: 6 },
  bubbleBot: { backgroundColor: '#fff', borderBottomLeftRadius: 6, borderWidth: 1, borderColor: colors.border },
  composer: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10,
    borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: '#fff',
  },
  input: {
    flex: 1, maxHeight: 110, minHeight: 42, backgroundColor: colors.background, borderRadius: 18,
    borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 10,
    fontSize: 14.5, color: colors.textPrimary,
  },
  sendBtn: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  headerBtn: { padding: 4 },
  errorText: { color: colors.urgent, fontSize: 12.5, fontWeight: '700', paddingHorizontal: 14, paddingTop: 8 },
  histPanel: { flex: 1, backgroundColor: colors.background },
  histBack: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 14, paddingVertical: 12 },
  histBackText: { color: colors.primary, fontSize: 14, fontWeight: '800' },
  histEmpty: { textAlign: 'center', color: colors.textMuted, fontSize: 14, paddingVertical: 24 },
  histRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderRadius: 14,
    paddingHorizontal: 12, paddingVertical: 11, borderWidth: 1, borderColor: colors.border,
  },
  histRowActive: { backgroundColor: colors.primaryLight, borderColor: colors.primary },
  histTitle: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  histTime: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  histDelete: { padding: 4 },
});
