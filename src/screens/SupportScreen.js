import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, Image, KeyboardAvoidingView, Platform, Alert, Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SignedImage from '../components/SignedImage';
import { useAuth } from '../context/AuthContext';
import { useJobs } from '../context/JobsContext';
import { useHaptic } from '../hooks/useHaptic';
import { pickImages, uploadPrivateImages } from '../lib/uploadImage';
import {
  fetchMyTickets, fetchTicketMessages, replyToTicket, markTicketRead, ticketHasUnread,
  pickActiveTicket, groupTickets,
  submitSupportRequest, setTicketArchived, resolveTicket, SUPPORT_CATEGORIES,
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
const CATEGORY_LABEL = SUPPORT_CATEGORIES.reduce((m, c) => ({ ...m, [c.key]: c.label }), {});

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
  const insets = useSafeAreaInsets();

  const [ticket, setTicket] = useState(null);
  // Every ticket, so a closed one is history rather than something that vanished. A
  // person who opened a second ticket for a different problem correctly sees the NEW
  // conversation — but the old one is still reachable, because "what did support tell
  // me last month" is a real question and losing it feels like being forgotten.
  const [allTickets, setAllTickets] = useState([]);
  const [showPast, setShowPast] = useState(false);
  // Several open tickets are allowed — the database never capped them, only this screen
  // did by always selecting the newest. A payments problem and a safety problem are not
  // the same conversation, and nobody should have to resolve one to report the other.
  const [composingNew, setComposingNew] = useState(false);
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
  // A thread the user deliberately tapped must survive a reload. useFocusEffect
  // re-runs load() on every focus, and re-picking the "best" thread each time would
  // yank them off the one they chose — including immediately after Mark resolved.
  const pickedIdRef = useRef(null);
  // Route params persist for the life of the screen. Re-reading the category on every
  // load re-armed the new-request form after each send, so a reply would be followed
  // by a blank compose screen the user did not ask for.
  const routeCategoryUsedRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const tickets = await fetchMyTickets();
      setAllTickets(tickets);
      // The ACTIVE conversation wins. Opening a new ticket for a different problem
      // therefore shows that new one, not the resolved one above it.
      // An explicit pick wins over the heuristic, as long as that thread still exists.
      const picked = pickedIdRef.current
        ? tickets.find(t => t.id === pickedIdRef.current)
        : null;
      const open = picked ?? pickActiveTicket(tickets);
      setTicket(open);
      // Arriving from a pre-scoped entry point (Payout Setup asks for 'payment') while
      // the open thread is about something else means this is a NEW problem. Dropping
      // someone into an unrelated conversation is how a report gets lost in a thread
      // nobody is reading for it.
      const wanted = routeCategoryUsedRef.current ? null : route?.params?.category;
      routeCategoryUsedRef.current = true;
      if (wanted && open && open.status !== 'closed' && open.category !== wanted) {
        setComposingNew(true);
      }
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

  // Thread ACTIONS belong in the nav bar, not stacked above the conversation. They
  // were six rows of chrome — subject, status, gig, two links, an archive toggle —
  // between the header and the first message, on a screen whose entire job is to show
  // the conversation.
  React.useLayoutEffect(() => {
    navigation?.setOptions?.({
      headerRight: () => (
        <TouchableOpacity
          onPress={() => { haptic.selection(); setMenuOpen(true); }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={{ paddingHorizontal: 6 }}
        >
          <Ionicons name="ellipsis-horizontal" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
      ),
    });
  }, [navigation]);

  // Both sides of the marketplace: gigs you worked and gigs you posted. Newest first,
  // capped — this is a shortcut, not a browser, and a long list would bury the composer.
  const ctx = CONTEXT_FOR[category] ?? null;

  // Resolve the ticket's attached gig from bookings already in memory — no extra query
  // just to render a title.
  const ticketContext = React.useMemo(() => {
    if (!ticket?.booking_id) return null;
    const b = [...(bookings ?? []), ...(posterBookings ?? [])].find(x => x.id === ticket.booking_id);
    if (!b?.job?.title) return null;
    const amt = b.amountCentsQuoted != null ? `$${(b.amountCentsQuoted / 100).toFixed(2)}` : null;
    return { title: b.job.title, sub: [amt, b.slotLabel].filter(Boolean).join(' · ') };
  }, [ticket?.booking_id, bookings, posterBookings]);

  // Threads are PER TOPIC, and that is forced by the schema rather than chosen for
  // taste: priority and booking_id both live on the ticket, and safety is urgent by
  // definition. Grouping + selection live in src/lib/support.js so the rules are
  // unit-tested rather than buried in render.
  const grouped = React.useMemo(
    () => groupTickets(allTickets, ticket?.id ?? null),
    [allTickets, ticket?.id],
  );
  const otherLive = grouped.live;
  const otherArchived = grouped.archived;
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

  const runMenu = async (fn) => {
    setMenuOpen(false);
    try { await fn(); await load(); } catch (e) {
      Alert.alert('Could not do that', e?.message ?? 'Please try again.');
    }
  };

  const openTicket = async (t) => {
    haptic.selection();
    pickedIdRef.current = t.id;
    setTicket(t);
    setShowPast(false);
    setMessages(await fetchTicketMessages(t.id).catch(() => []));
    markTicketRead(t.id).catch(() => {});
  };

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
      // A reply to a CLOSED ticket reopens it server-side (20260806380000) — that is
      // the sanctioned way back into a conversation that was resolved too early, and it
      // keeps the history rather than starting from nothing.
      // ticket === undefined means the LOAD FAILED — we do not know what threads exist.
      // Falling through here would post the user's reply as a brand-new ticket,
      // duplicating a conversation they believe they are continuing. Refuse instead.
      if (ticket === undefined) {
        throw new Error('Still reconnecting — pull down to refresh, then send again.');
      }
      if (ticket && !composingNew) {
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
      setDraft(''); setPhotos([]); setComposingNew(false); setLinkedBooking(null);
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
      {/* Full reassurance on FIRST contact, where "will anyone actually read this?"
          is the question stopping people from writing. Once a conversation exists it
          has been answered, so it shrinks to the one line that still matters legally
          and stops eating the screen. */}
      <View style={styles.banner}>
        <Ionicons name="shield-checkmark" size={15} color={colors.primary} />
        <Text style={styles.bannerText} numberOfLines={2}>
          {ticket && !composingNew
            ? 'For emergencies, call your local emergency number first.'
            : 'A real person reads this. For anything urgent about your safety, contact your local emergency number first.'}
        </Text>
      </View>

      {/* Other live conversations — OUTSIDE the ScrollView on purpose. The thread
          below force-scrolls to the bottom (it is a chat), so anything rendered above
          the messages is scrolled past before the user ever sees it. A thread support
          opened about a flag cannot live somewhere you have to scroll up to find. */}
      {!loading && otherLive.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.switcher}
          contentContainerStyle={styles.switcherInner}
        >
          {otherLive.map(t => {
            const un = ticketHasUnread(t);
            return (
              <TouchableOpacity
                key={t.id}
                style={[styles.switchChip, un && styles.switchChipUnread]}
                onPress={() => openTicket(t)}
              >
                {un && <View style={styles.unreadDot} />}
                <Text style={[styles.switchChipText, un && styles.switchChipTextUnread]} numberOfLines={1}>
                  {t.subject || CATEGORY_LABEL[t.category] || 'Support'}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

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

          {(ticket === null || composingNew) && ticket !== undefined && (
            <>
              {composingNew && !!ticket && (
                <TouchableOpacity onPress={() => { haptic.selection(); setComposingNew(false); }}>
                  <Text style={styles.newRequestLink}>← Back to “{ticket.subject || 'your conversation'}”</Text>
                </TouchableOpacity>
              )}
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
                {CATEGORY_LABEL[ticket.category] ?? 'Support'}
                {' · '}
                {ticket.status === 'closed' ? 'Closed' : ticket.status === 'pending' ? 'We replied' : 'We’re on it'}
                {ticket.priority === 'urgent' ? ' · urgent' : ''}
              </Text>
              {/* What it is ABOUT, restated at the top. A thread that has scrolled for a
                  week should still answer "which gig is this?" without reading upward. */}
              {!!ticketContext && (
                <View style={styles.contextCard}>
                  <Ionicons name="briefcase-outline" size={14} color={colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.contextTitle} numberOfLines={1}>{ticketContext.title}</Text>
                    {!!ticketContext.sub && (
                      <Text style={styles.contextSub} numberOfLines={1}>{ticketContext.sub}</Text>
                    )}
                  </View>
                </View>
              )}

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
            Marked resolved. Reply here if it isn’t — that reopens this conversation.
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

      {/* ── Thread menu ──────────────────────────────────────────────────────
          Everything that is not the conversation itself. Archive lives here too:
          it is reference, and a list of resolved threads does not belong above the
          message you are trying to read. */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <TouchableOpacity style={styles.menuBackdrop} activeOpacity={1} onPress={() => setMenuOpen(false)}>
          <View style={[styles.menuSheet, { top: insets.top + 46 }]}>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => { setMenuOpen(false); haptic.selection(); setComposingNew(true); setLinkedBooking(null); }}
            >
              <Ionicons name="add-circle-outline" size={19} color={colors.primary} />
              <Text style={styles.menuText}>Start a new request</Text>
            </TouchableOpacity>

            {!!ticket && ticket.status !== 'closed' && (
              <TouchableOpacity style={styles.menuItem} onPress={() => runMenu(() => resolveTicket(ticket.id))}>
                <Ionicons name="checkmark-done-outline" size={19} color={colors.textPrimary} />
                <Text style={styles.menuText}>Mark resolved</Text>
              </TouchableOpacity>
            )}

            {!!ticket && (
              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => runMenu(() => setTicketArchived(ticket.id, !ticket.archived_at))}
              >
                <Ionicons name={ticket.archived_at ? 'arrow-undo-outline' : 'archive-outline'} size={19} color={colors.textPrimary} />
                <Text style={styles.menuText}>{ticket.archived_at ? 'Unarchive' : 'Archive'}</Text>
              </TouchableOpacity>
            )}

            {otherArchived.length > 0 && (
              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => { setMenuOpen(false); haptic.selection(); setShowPast(true); }}
              >
                <Ionicons name="file-tray-full-outline" size={19} color={colors.textPrimary} />
                <Text style={styles.menuText}>Past conversations ({otherArchived.length})</Text>
              </TouchableOpacity>
            )}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Archive list, opened from the menu. */}
      <Modal visible={showPast} transparent animationType="slide" onRequestClose={() => setShowPast(false)}>
        <View style={styles.menuBackdrop}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setShowPast(false)} />
          <View style={styles.archiveSheet}>
            <Text style={styles.archiveTitle}>Past conversations</Text>
            <ScrollView>
              {otherArchived.map(t => (
                <TouchableOpacity
                  key={t.id}
                  style={styles.pastRow}
                  onPress={() => { setShowPast(false); openTicket(t); }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pastRowTitle} numberOfLines={1}>{t.subject || 'Support request'}</Text>
                    <Text style={styles.pastRowMeta} numberOfLines={1}>
                      {CATEGORY_LABEL[t.category] ?? 'Support'}
                      {' · '}
                      {t.archived_at && t.status !== 'closed' ? 'archived' : 'resolved'}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.archiveClose} onPress={() => setShowPast(false)}>
              <Text style={styles.archiveCloseText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

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
  contextCard: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10,
    backgroundColor: colors.primaryLight, borderRadius: radii.md,
    paddingVertical: 9, paddingHorizontal: 11,
  },
  contextTitle: { fontSize: 13, fontWeight: '700', color: colors.textPrimary },
  contextSub: { fontSize: 11, color: colors.textSecondary, marginTop: 1 },
  menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  menuSheet: {
    // `top` is supplied at render from the safe-area inset + nav-bar height: a fixed
    // offset put the first item under the Dynamic Island on this device.
    position: 'absolute', right: 12, minWidth: 230,
    backgroundColor: colors.surface, borderRadius: radii.lg, paddingVertical: 6, ...shadows.card,
  },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 12, paddingHorizontal: 15 },
  menuText: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  archiveSheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    padding: 20, maxHeight: '70%',
  },
  archiveTitle: { fontSize: 17, fontWeight: '800', color: colors.textPrimary, marginBottom: 10 },
  archiveClose: {
    backgroundColor: colors.primary, borderRadius: radii.pill, paddingVertical: 13,
    alignItems: 'center', marginTop: 14,
  },
  archiveCloseText: { fontSize: 15, fontWeight: '800', color: '#fff' },
  ticketActions: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  secondaryLink: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginTop: 12 },
  newRequestLink: {
    fontSize: 13, fontWeight: '700', color: colors.primary, marginTop: 12,
  },
  pastToggle: { fontSize: 12, fontWeight: '600', color: colors.primary, marginTop: 10 },
  switcher: { maxHeight: 46, flexGrow: 0, backgroundColor: colors.background },
  switcherInner: { gap: 6, paddingHorizontal: 14, paddingBottom: 8 },
  switchChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 11, paddingVertical: 7, borderRadius: radii.pill,
    borderWidth: 1, borderColor: colors.divider, backgroundColor: colors.surface, maxWidth: 210,
  },
  switchChipUnread: { borderColor: colors.primary },
  switchChipText: { fontSize: 12, fontWeight: '600', color: colors.textSecondary, flexShrink: 1 },
  switchChipTextUnread: { color: colors.textPrimary, fontWeight: '800' },
  groupLabel: {
    fontSize: 11, fontWeight: '800', color: colors.textSecondary, textTransform: 'uppercase',
    letterSpacing: 0.4, marginTop: 14, marginBottom: 6,
  },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary, marginRight: 8 },
  pastRowTitleUnread: { fontWeight: '800', color: colors.textPrimary },
  pastRow: {
    flexDirection: 'row', alignItems: 'center',
    marginTop: 8, paddingVertical: 9, paddingHorizontal: 11,
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.divider,
  },
  pastRowTitle: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  pastRowMeta: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
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
