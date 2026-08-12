import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, Image, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import SignedImage from '../components/SignedImage';
import { useAuth } from '../context/AuthContext';
import { useJobs } from '../context/JobsContext';
import { useHaptic } from '../hooks/useHaptic';
import { pickImages, uploadPrivateImages } from '../lib/uploadImage';
import {
  fetchMyTickets, fetchTicketMessages, replyToTicket, markTicketRead,
  submitSupportRequest, SUPPORT_CATEGORIES,
} from '../lib/support';
import { colors, radii, shadows } from '../theme';

// What each category lets you attach.
//
// Every marketplace that does support well asks you to point at the THING first — Uber
// a trip, DoorDash an order, Airbnb a reservation, Tesla a vehicle and service visit —
// because the person asking for help is the one least able to describe it. They are
// upset, they do not know your vocabulary, and "the dog walking one from Tuesday" costs
// an agent a round trip to resolve.
//
// So the picker is driven by the category rather than shown generically:
//   payment  a gig with its MONEY state, because "where is my $20" is answered by
//            knowing which $20 and whether it is held, paid or released
//   booking  a gig with its DATE and the other party
//   safety   the same, because the thing that matters is which gig it happened on
//   account  nothing — there is no object, and an empty picker is noise
//   bug      nothing — the screen they were on is better captured in their own words
//   other    optional gig, since "something else" often turns out to be about one
const CONTEXT_FOR = {
  payment: { mode: 'money', label: 'Which payment is this about? (optional)' },
  booking: { mode: 'gig',   label: 'Which gig is this about? (optional)' },
  safety:  { mode: 'gig',   label: 'Which gig did this happen on? (optional)' },
  other:   { mode: 'gig',   label: 'Is this about a specific gig? (optional)' },
};

// The support conversation.
//
// Until now support was one-way: you filed a request and the reply arrived by email,
// outside the app. The tables had RLS enabled with no policies, so the client could not
// read its own ticket even if it tried. This is the other half.
//
// Deliberately ONE thread rather than a ticket list. Someone contacting support has a
// problem, not a filing system; making them pick which of their tickets to open is
// admin work at the worst possible moment. The newest open ticket IS the conversation,
// and starting a new topic closes nothing — it just appends.

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function SupportScreen({ navigation, route }) {
  const { user } = useAuth();
  const haptic = useHaptic();
  const scrollRef = useRef(null);

  const [ticket, setTicket] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState('');
  const [photos, setPhotos] = useState([]);
  // Only asked when there is no open thread — an existing conversation already has one.
  const [category, setCategory] = useState(route?.params?.category ?? 'other');
  // Optional context. An agent who can open the exact gig resolves in one reply instead
  // of spending a round trip asking "which one?" — and the person asking for help is
  // usually least able to describe it precisely, because they are upset.
  const { bookings, posterBookings } = useJobs();
  const [linkedBooking, setLinkedBooking] = useState(route?.params?.bookingId ?? null);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const tickets = await fetchMyTickets();
      const open = tickets.find(t => t.status !== 'closed') ?? tickets[0] ?? null;
      setTicket(open);
      if (open) {
        const msgs = await fetchTicketMessages(open.id);
        setMessages(msgs);
        // Opening the thread IS reading it; the Messages badge should clear now, not
        // after some later action.
        markTicketRead(open.id).catch(() => {});
      } else {
        setMessages([]);
      }
    } catch (_) {
      // A load failure must not present as "you have no support history" — that would
      // tell someone their open problem had vanished.
      setTicket(undefined);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Both sides of the marketplace: gigs you worked and gigs you posted. Newest first,
  // capped — this is a shortcut, not a browser, and a long list would bury the composer.
  const ctx = CONTEXT_FOR[category] ?? null;

  const recentGigs = React.useMemo(() => {
    const seen = new Set();
    // Says what happened to the money, in the words someone would use to recognise it.
    // "$20.00 · held in escrow" is what turns a list of gigs into a list of payments.
    const money = (b) => {
      const amt = b.amountCentsQuoted != null ? `$${(b.amountCentsQuoted / 100).toFixed(2)}` : null;
      const state = {
        pending:   'not accepted yet',
        confirmed: 'held in escrow',
        completed: 'awaiting verification',
        verified:  'paid out',
        declined:  'released back',
        cancelled: 'released back',
      }[b.status] ?? b.status;
      return [amt, state].filter(Boolean).join(' · ');
    };
    const when = (b) => (b.slotLabel || (b.startsAt
      ? new Date(b.startsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : ''));

    return [...(bookings ?? []), ...(posterBookings ?? [])]
      .filter(b => b?.id && b?.job?.title)
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
      .filter(b => (seen.has(b.id) ? false : (seen.add(b.id), true)))
      .slice(0, 6)
      .map(b => ({
        bookingId: b.id,
        title: b.job.title,
        sub: ctx?.mode === 'money' ? money(b) : when(b),
      }));
  }, [bookings, posterBookings, ctx?.mode]);

  const addPhotos = async () => {
    haptic.selection();
    const res = await pickImages({ multiple: true });
    if (res?.length) setPhotos(prev => [...prev, ...res].slice(0, 6));
  };

  const send = async () => {
    const body = draft.trim();
    if ((!body && photos.length === 0) || sending) return;
    setSending(true);
    try {
      let paths = [];
      if (photos.length && user?.id) {
        paths = await uploadPrivateImages({ uris: photos, bucket: 'support-photos', userId: user.id });
      }
      // A CLOSED ticket cannot be replied to — support_messages_write_own refuses it,
      // by design. Without this branch a user whose only thread had been closed would
      // tap send and get "this conversation was closed" forever, with no way to start
      // another: the screen would keep selecting that same closed ticket. Opening a new
      // one is the correct behaviour and needs no action from them.
      if (ticket && ticket.status !== 'closed') {
        await replyToTicket(ticket.id, { body, images: paths });
      } else {
        // No open thread — this first message opens one. submitSupportRequest goes
        // through the support-submit edge function, which is what attributes the ticket
        // and rate-limits intake.
        await submitSupportRequest({
          subject: body.slice(0, 60) || 'Support request',
          message: body || 'See attached photos.',
          category,
          bookingId: linkedBooking,
        });
      }
      setDraft(''); setPhotos([]);
      await load();
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 120);
      haptic.success();
    } catch (e) {
      haptic.error();
      Alert.alert('Could not send', e?.message ?? 'Please try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 96 : 0}
    >
      <View style={styles.banner}>
        <Ionicons name="shield-checkmark" size={16} color={colors.primary} />
        <Text style={styles.bannerText} numberOfLines={2}>
          A real person reads this. For anything urgent about your safety, contact your
          local emergency number first.
        </Text>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.scroll}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          {ticket === undefined && (
            <Text style={styles.loadError}>
              Couldn’t load your messages. Check your connection and pull back in a moment —
              nothing you’ve sent has been lost.
            </Text>
          )}

          {ticket === null && (
            <>
              <Text style={styles.emptyTitle}>How can we help?</Text>
              <Text style={styles.emptyText}>
                Payments, a gig that went wrong, your account, or anything else. Add photos
                if they help explain it.
              </Text>
              <View style={styles.catRow}>
                {SUPPORT_CATEGORIES.map(c => (
                  <TouchableOpacity
                    key={c.key}
                    style={[styles.catChip, category === c.key && styles.catChipActive]}
                    onPress={() => {
                      haptic.selection();
                      setCategory(c.key);
                      // Dropping to a category with no picker must not silently keep a
                      // gig attached from the previous one — the agent would read
                      // context the user believes they removed.
                      if (!CONTEXT_FOR[c.key]) setLinkedBooking(null);
                    }}
                  >
                    <Text style={[styles.catText, category === c.key && styles.catTextActive]} numberOfLines={1}>
                      {c.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {!!ctx && recentGigs.length > 0 && (
                <>
                  <Text style={styles.pickerLabel}>{ctx.label}</Text>
                  <View style={styles.catRow}>
                    {recentGigs.map(g => {
                      const on = linkedBooking === g.bookingId;
                      return (
                        <TouchableOpacity
                          key={g.bookingId}
                          style={[styles.gigChip, on && styles.gigChipActive]}
                          onPress={() => { haptic.selection(); setLinkedBooking(on ? null : g.bookingId); }}
                        >
                          <Ionicons
                            name={on ? 'checkmark-circle' : 'ellipse-outline'}
                            size={13}
                            color={on ? '#fff' : colors.textMuted}
                          />
                          <View style={{ flexShrink: 1 }}>
                            <Text style={[styles.gigChipText, on && styles.gigChipTextActive]} numberOfLines={1}>
                              {g.title}
                            </Text>
                            {!!g.sub && (
                              <Text style={[styles.gigChipSub, on && styles.gigChipSubActive]} numberOfLines={1}>
                                {g.sub}
                              </Text>
                            )}
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </>
              )}
            </>
          )}

          {!!ticket && (
            <View style={styles.ticketHead}>
              <Text style={styles.ticketSubject} numberOfLines={2}>{ticket.subject || 'Support request'}</Text>
              <Text style={styles.ticketMeta}>
                {ticket.status === 'closed' ? 'Closed' : ticket.status === 'pending' ? 'We replied' : 'We’re on it'}
                {ticket.priority === 'urgent' ? ' · urgent' : ''}
              </Text>
            </View>
          )}

          {messages.map(m => {
            const mine = m.author === 'user';
            return (
              <View key={m.id} style={[styles.bubbleWrap, mine ? styles.bubbleRight : styles.bubbleLeft]}>
                {!mine && (
                  <View style={styles.agentTag}>
                    <Ionicons name="shield-checkmark" size={11} color={colors.primary} />
                    <Text style={styles.agentTagText}>GoHustlr Support</Text>
                  </View>
                )}
                <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                  {!!m.body && (
                    <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{m.body}</Text>
                  )}
                  {(m.images ?? []).map((p, i) => (
                    <SignedImage key={i} value={p} bucket="support-photos" style={styles.msgImage} />
                  ))}
                </View>
                <Text style={styles.bubbleTime}>{timeLabel(m.created_at)}</Text>
              </View>
            );
          })}
        </ScrollView>
      )}

      {ticket?.status === 'closed' ? (
        <View style={styles.closedBar}>
          <Text style={styles.closedText} numberOfLines={2}>
            This conversation is closed. Send a message to open a new one.
          </Text>
        </View>
      ) : null}

      <View style={styles.composer}>
        {photos.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.photoStrip}>
            {photos.map((u, i) => (
              <View key={i} style={styles.thumbWrap}>
                <Image source={{ uri: u }} style={styles.thumb} />
                <TouchableOpacity
                  style={styles.thumbRemove}
                  onPress={() => setPhotos(prev => prev.filter((_, idx) => idx !== i))}
                >
                  <Ionicons name="close" size={11} color="#fff" />
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        )}
        <View style={styles.composerRow}>
          <TouchableOpacity onPress={addPhotos} style={styles.attachBtn} accessibilityLabel="Add a photo">
            <Ionicons name="image-outline" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
          <TextInput
            style={styles.input}
            placeholder={ticket ? 'Write a message…' : 'Describe what’s going on…'}
            placeholderTextColor={colors.textMuted}
            value={draft}
            onChangeText={setDraft}
            multiline
            maxLength={2000}
            returnKeyType="send"
            blurOnSubmit={false}
            onSubmitEditing={send}
          />
          <TouchableOpacity
            onPress={send}
            disabled={sending || (!draft.trim() && photos.length === 0)}
            style={[styles.sendBtn, (sending || (!draft.trim() && photos.length === 0)) && styles.sendBtnOff]}
            accessibilityLabel="Send"
          >
            {sending
              ? <ActivityIndicator size="small" color="#fff" />
              : <Ionicons name="arrow-up" size={18} color="#fff" />}
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.primaryLight, paddingHorizontal: 16, paddingVertical: 10,
  },
  bannerText: { flex: 1, fontSize: 12, color: colors.textSecondary, lineHeight: 16 },
  scroll: { padding: 16, paddingBottom: 24 },
  loadError: { fontSize: 13, color: colors.urgent, lineHeight: 18, marginBottom: 12 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: colors.textPrimary, marginBottom: 6 },
  emptyText: { fontSize: 13, color: colors.textSecondary, lineHeight: 19, marginBottom: 14 },
  catRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  catChip: {
    paddingVertical: 7, paddingHorizontal: 12, borderRadius: radii.pill,
    borderWidth: 1, borderColor: colors.divider, backgroundColor: colors.surface,
  },
  catChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  catText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
  catTextActive: { color: '#fff' },
  pickerLabel: {
    fontSize: 13, fontWeight: '600', color: colors.textPrimary, marginTop: 6, marginBottom: 8,
  },
  gigChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%',
    paddingVertical: 7, paddingHorizontal: 12, borderRadius: radii.pill,
    borderWidth: 1, borderColor: colors.divider, backgroundColor: colors.surface,
  },
  gigChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  gigChipText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600', flexShrink: 1 },
  gigChipSub: { fontSize: 10, color: colors.textMuted, marginTop: 1 },
  gigChipSubActive: { color: 'rgba(255,255,255,0.85)' },
  gigChipTextActive: { color: '#fff' },
  ticketHead: { marginBottom: 14 },
  ticketSubject: { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
  ticketMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  bubbleWrap: { marginBottom: 14, maxWidth: '85%' },
  bubbleLeft: { alignSelf: 'flex-start' },
  bubbleRight: { alignSelf: 'flex-end' },
  agentTag: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4, marginLeft: 2 },
  agentTagText: { fontSize: 11, fontWeight: '700', color: colors.primary },
  bubble: { borderRadius: radii.lg, paddingVertical: 10, paddingHorizontal: 13, ...shadows.sm },
  bubbleMine: { backgroundColor: colors.primary },
  bubbleTheirs: { backgroundColor: colors.surface },
  bubbleText: { fontSize: 14, color: colors.textPrimary, lineHeight: 20 },
  bubbleTextMine: { color: '#fff' },
  msgImage: { width: 180, height: 135, borderRadius: radii.md, marginTop: 8, backgroundColor: colors.background },
  bubbleTime: { fontSize: 10, color: colors.textMuted, marginTop: 4, marginHorizontal: 2 },
  closedBar: { paddingHorizontal: 16, paddingBottom: 6 },
  closedText: { fontSize: 12, color: colors.textMuted },
  composer: {
    borderTopWidth: 1, borderTopColor: colors.divider, backgroundColor: colors.background,
    paddingHorizontal: 20, paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 28 : 16,
  },
  photoStrip: { marginBottom: 8 },
  thumbWrap: { position: 'relative', marginRight: 8 },
  thumb: { width: 52, height: 52, borderRadius: radii.sm, backgroundColor: colors.background },
  thumbRemove: {
    position: 'absolute', top: -5, right: -5, width: 18, height: 18, borderRadius: 9,
    backgroundColor: colors.textPrimary, alignItems: 'center', justifyContent: 'center',
  },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end' },
  attachBtn: { paddingBottom: 10, paddingRight: 10 },
  input: {
    flex: 1, backgroundColor: colors.surface, borderRadius: radii.pill,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 16, paddingVertical: 10,
    fontSize: 14, color: colors.textPrimary, maxHeight: 100, lineHeight: 19,
    marginRight: 8,
  },
  sendBtn: {
    width: 42, height: 42, borderRadius: radii.pill,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  // Keep the brand fill so the white arrow stays legible; fade the whole control.
  sendBtnOff: { opacity: 0.4 },
});
