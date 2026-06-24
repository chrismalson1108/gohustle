import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Modal, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform, SafeAreaView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { askAssistant } from '../lib/assistantClient';
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
  const scrollRef = useRef(null);
  const haptic = useHaptic();

  const { refreshJobs, refreshBookings, refreshPosterBookings } = useJobs();
  const { refreshProfile, showToast } = useUser();

  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([{ role: 'assistant', content: GREETING }]);
    }
  }, [open]);

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
    const next = [...messages, { role: 'user', content: trimmed }];
    setMessages(next);
    setBusy(true);
    try {
      const { reply, actions } = await askAssistant(next);
      setMessages([...next, { role: 'assistant', content: reply }]);
      runActions(actions);
    } catch (err) {
      setMessages([...next, { role: 'assistant', content: err.message || 'Something went wrong. Try again.' }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Floating launcher — sits above the tab bar */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => { haptic?.light?.(); setOpen(true); }}
        activeOpacity={0.85}
        accessibilityLabel="Open Hustlr AI assistant"
      >
        <Ionicons name="sparkles" size={26} color="#fff" />
      </TouchableOpacity>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.modal}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            {/* Header */}
            <View style={styles.header}>
              <View style={styles.headerIcon}>
                <Ionicons name="sparkles" size={20} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.headerTitle}>Hustlr AI</Text>
                <Text style={styles.headerSub}>Your gig sidekick</Text>
              </View>
              <TouchableOpacity onPress={() => setOpen(false)} accessibilityLabel="Close">
                <Ionicons name="close" size={26} color="#fff" />
              </TouchableOpacity>
            </View>

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
            <View style={styles.composer}>
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
          </KeyboardAvoidingView>
        </SafeAreaView>
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

const styles = StyleSheet.create({
  fab: {
    position: 'absolute', right: 16, bottom: 80, width: 56, height: 56, borderRadius: 28,
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
});
