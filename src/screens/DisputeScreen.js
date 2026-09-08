import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import { useHaptic } from '../hooks/useHaptic';
import { pickImages, uploadPrivateImages } from '../lib/uploadImage';
import { findProhibited } from '../lib/contentFilter';
import { logModerationBlock } from '../lib/moderation';
import { formatMoney } from '../lib/finance';
import SignedImage from '../components/SignedImage';
import { colors, radii } from '../theme';

// ─────────────────────────────────────────────────────────────────────────────
// The screen the accused party never had.
//
// A tester put the case exactly: "you pay to fix door A, then report an issue and post
// an issue on door B. Worker should be able to say 'no that's door B, we worked on
// door A'." Until now they could not — no client anywhere read public.disputes, so the
// earner learned only that they had been paid less, from a push that named no reason.
//
// 20260906059000 hardened the storage policy SPECIFICALLY so "the accused earner" could
// open the poster's photos, with a post-deploy assertion. The access has existed for
// three days with nothing to exercise it. This is the thing that exercises it.
//
// Read goes through my_dispute() rather than a direct select: the RLS policy exposes
// assigned_to and resolved_by, which are STAFF ids, so the RPC whitelists columns and
// closes that leak on the way past.
// ─────────────────────────────────────────────────────────────────────────────
export default function DisputeScreen({ route, navigation }) {
  const { bookingId } = route.params ?? {};
  const insets = useSafeAreaInsets();
  const haptic = useHaptic();
  const { user } = useAuth();
  const { showToast } = useUser();
  const { bookings, refreshBookings } = useJobs();

  const [dispute, setDispute] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState([]);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(null); // null | 'contest'

  const booking = bookings.find((b) => b.id === bookingId);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('my_dispute', { p_booking_id: bookingId });
    // An error and an empty result are NOT the same thing and must not read the same:
    // "nothing here" on a failed read tells somebody their case does not exist.
    if (error) { setFailed(true); setDispute(null); }
    else { setFailed(false); setDispute(Array.isArray(data) ? data[0] ?? null : data ?? null); }
    setLoading(false);
  }, [bookingId]);

  useEffect(() => { load(); }, [load]);

  const isRespondent = dispute && user?.id === dispute.respondent_id;
  // The poster opens this same screen from Hire to watch their own report. Every label
  // below is perspective-dependent, and getting it wrong on a money screen reads as a
  // bug about somebody else's money.
  const isRaiser = dispute && user?.id === dispute.raised_by;
  const settled = dispute?.pct_paid != null;
  const answered = !!dispute?.responded_at;

  // What is actually at stake, in dollars — not a percentage. "75%" of an unstated
  // number is not information a person can act on.
  const amountCents = booking?.amountCentsQuoted ?? null;
  const proposed = dispute?.proposed_pct ?? 100;
  const atStake = amountCents != null ? Math.round((amountCents * (100 - proposed)) / 100) : null;

  const hoursLeft = dispute?.settle_after
    ? Math.max(0, Math.round((new Date(dispute.settle_after).getTime() - Date.now()) / 3_600_000))
    : null;

  async function addPhotos() {
    // pickImages resolves to { canceled, denied?, uris } — NEVER an array. Testing
    // `.length` on that object is always undefined, which is how the poster's own sheet
    // silently dropped every photo once.
    const res = await pickImages({ multiple: true });
    if (res.canceled) {
      if (res.denied) Alert.alert('Photos access needed', 'Allow photo access in Settings to attach photos.');
      return;
    }
    if (!res.uris?.length) return;
    setBusy(true);
    try {
      const paths = await uploadPrivateImages({
        uris: res.uris, bucket: 'completion-photos', userId: user.id,
      });
      setPhotos((p) => [...p, ...paths].slice(0, 6));
    } catch {
      showToast({ icon: '⚠️', title: "Couldn't add photos", message: 'Please try again.' });
    } finally {
      setBusy(false);
    }
  }

  async function respond(stance) {
    if (stance === 'contest' && !note.trim()) {
      showToast({ icon: '⚠️', title: 'Add your side', message: 'Say what actually happened so it can be reviewed.' });
      return;
    }
    // The same filter the poster's review passes. This text is read by staff and can be
    // shown back to the other party, so it is held to the same standard as any other
    // user text — the dispute REASON was the one field on the poster's sheet that
    // skipped moderation, and that is fixed on the other side too.
    const term = note && findProhibited(note);
    if (term) {
      logModerationBlock(term, 'dispute_response', note);
      showToast({ icon: '🚫', title: 'Not allowed', message: "That contains words that aren't allowed. Please edit it." });
      return;
    }
    setBusy(true);
    haptic.light();
    try {
      const { error } = await supabase.rpc('respond_to_dispute', {
        p_dispute_id: dispute.id,
        p_stance: stance,
        p_note: note.trim() || null,
        p_photos: photos,
      });
      if (error) throw error;
      showToast(
        stance === 'accept'
          ? { icon: '✅', title: 'Accepted', message: 'This will be paid at the adjusted amount shortly.' }
          : { icon: '📨', title: 'Sent', message: 'Nothing is paid until a person has read both sides.' },
      );
      await load();
      await refreshBookings();
    } catch (e) {
      showToast({ icon: '⚠️', title: "Couldn't send", message: e?.message || 'Please try again.' });
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
    );
  }
  if (failed) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>Couldn&apos;t load this</Text>
        <Text style={styles.emptyBody}>Something on our side went wrong. Your case is unaffected.</Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={load}>
          <Text style={styles.primaryBtnText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!dispute) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>Nothing reported</Text>
        <Text style={styles.emptyBody}>There is no open report on this gig.</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
      keyboardShouldPersistTaps="handled"
    >
      {/* What is at stake, first and in money. */}
      <View style={styles.hero}>
        <Text style={styles.heroLabel}>{isRaiser ? 'You asked to pay' : 'The poster asked to pay'}</Text>
        <Text style={styles.heroPct}>{proposed}%</Text>
        {atStake != null && (
          <Text style={styles.heroSub}>
            {isRaiser
              ? `${formatMoney(atStake / 100)} comes back to you if this stands`
              : `${formatMoney(atStake / 100)} of your pay is on hold`}
          </Text>
        )}
        {!settled && !answered && hoursLeft != null && (
          <View style={styles.clock}>
            <Ionicons name="time-outline" size={14} color={colors.warningDeep} style={{ marginRight: 5 }} />
            <Text style={styles.clockText}>
              {hoursLeft > 0
                ? `${hoursLeft} hour${hoursLeft === 1 ? '' : 's'} left ${isRaiser ? 'for them to reply' : 'to reply'}`
                : 'The reply window has closed'}
            </Text>
          </View>
        )}
      </View>

      {/* Their side. */}
      <Section title={isRaiser ? 'What you said' : 'What they said'}>
        <Text style={styles.reason}>{dispute.reason || 'No reason given.'}</Text>
        {dispute.photos?.length > 0 && (
          <>
            <Text style={styles.subLabel}>{isRaiser ? 'Your photos' : 'Their photos'}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip}>
              {dispute.photos.map((p) => (
                <SignedImage key={p} value={p} bucket="completion-photos" style={styles.photo} />
              ))}
            </ScrollView>
          </>
        )}
      </Section>

      {/* Your side. */}
      {answered ? (
        <Section title={isRaiser ? 'Their reply' : 'Your reply'}>
          <Text style={styles.stance}>
            {dispute.response_stance === 'accept'
              ? (isRaiser ? 'They accepted the adjustment.' : 'You accepted the adjustment.')
              : (isRaiser ? 'They disputed this.' : 'You disputed this.')}
          </Text>
          {dispute.response_note ? <Text style={styles.reason}>{dispute.response_note}</Text> : null}
          {dispute.response_photos?.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip}>
              {dispute.response_photos.map((p) => (
                <SignedImage key={p} value={p} bucket="completion-photos" style={styles.photo} />
              ))}
            </ScrollView>
          )}
          {!settled && dispute.response_stance === 'contest' && (
            <Text style={styles.note}>
              Nothing is paid while this is open. Someone from GoHustlr reads both sides —
              and if we have not decided before the card hold runs out, you are paid in
              FULL rather than the amount they asked for.
            </Text>
          )}
        </Section>
      ) : settled ? null : isRaiser ? (
        <Section title="Waiting for them">
          <Text style={styles.note}>
            They have been told, and can accept or reply until{' '}
            {dispute.settle_after ? new Date(dispute.settle_after).toLocaleString() : 'the window closes'}.
            If they say nothing, this settles at {proposed}% on its own — you do not need to do anything.
          </Text>
        </Section>
      ) : isRespondent ? (
        <Section title="Your side">
          {mode !== 'contest' ? (
            <>
              <Text style={styles.note}>
                If they are right, accepting pays you {proposed}% now. If they are not, say
                what actually happened — nothing is paid while we look at it, and if we run
                out of time you are paid in full.
              </Text>
              <View style={styles.row}>
                <TouchableOpacity
                  style={[styles.secondaryBtn, styles.flex]}
                  disabled={busy}
                  onPress={() => respond('accept')}
                >
                  <Text style={styles.secondaryBtnText}>Accept {proposed}%</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.primaryBtn, styles.flex]}
                  disabled={busy}
                  onPress={() => { haptic.light(); setMode('contest'); }}
                >
                  <Text style={styles.primaryBtnText}>That&apos;s not right</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.subLabel}>What actually happened</Text>
              <TextInput
                value={note}
                onChangeText={setNote}
                multiline
                maxLength={1000}
                placeholder="e.g. That's the back door — we were hired for the front, and it's in our finished photos."
                placeholderTextColor={colors.textMuted}
                style={styles.input}
              />
              <TouchableOpacity style={styles.addPhotos} onPress={addPhotos} disabled={busy}>
                <Ionicons name="camera-outline" size={16} color={colors.primary} style={{ marginRight: 6 }} />
                <Text style={styles.addPhotosText}>
                  {photos.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'} added` : 'Add your photos'}
                </Text>
              </TouchableOpacity>
              <View style={styles.row}>
                <TouchableOpacity style={[styles.secondaryBtn, styles.flex]} disabled={busy} onPress={() => setMode(null)}>
                  <Text style={styles.secondaryBtnText}>Back</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.primaryBtn, styles.flex, busy && styles.disabled]}
                  disabled={busy}
                  onPress={() => respond('contest')}
                >
                  <Text style={styles.primaryBtnText}>{busy ? 'Sending…' : 'Send my reply'}</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.note}>You can reply once, so include everything that matters.</Text>
            </>
          )}
        </Section>
      ) : null}

      {settled && (
        <Section title="Outcome">
          <Text style={styles.stance}>
            Settled at {dispute.pct_paid}%
            {dispute.resolution_pct != null ? ' by GoHustlr' : ''}.
          </Text>
          {dispute.resolution_note ? <Text style={styles.reason}>{dispute.resolution_note}</Text> : null}
        </Section>
      )}

      <TouchableOpacity
        style={styles.helpRow}
        onPress={() => navigation.navigate('Support')}
      >
        <Ionicons name="help-buoy-outline" size={16} color={colors.textSecondary} style={{ marginRight: 6 }} />
        <Text style={styles.helpText}>Something else wrong? Contact support</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function Section({ title, children }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: colors.background },
  emptyTitle: { fontSize: 19, fontWeight: '700', color: colors.textPrimary, marginBottom: 6 },
  emptyBody: { fontSize: 14.5, color: colors.textSecondary, textAlign: 'center', marginBottom: 18, lineHeight: 20 },

  hero: {
    backgroundColor: colors.surface, borderRadius: radii.xl, padding: 20, marginBottom: 16,
    alignItems: 'center',
  },
  heroLabel: { fontSize: 13.5, color: colors.textSecondary, marginBottom: 4 },
  heroPct: { fontSize: 46, fontWeight: '800', color: colors.textPrimary, letterSpacing: -1 },
  heroSub: { fontSize: 14.5, color: colors.textSecondary, marginTop: 2 },
  clock: {
    flexDirection: 'row', alignItems: 'center', marginTop: 12,
    backgroundColor: colors.warningLight, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6,
  },
  clockText: { fontSize: 12.5, fontWeight: '700', color: colors.warningDeep },

  section: { backgroundColor: colors.surface, borderRadius: radii.xl, padding: 18, marginBottom: 14 },
  sectionTitle: { fontSize: 12.5, fontWeight: '700', color: colors.textMuted, marginBottom: 10, letterSpacing: 0.3 },
  reason: { fontSize: 15, color: colors.textPrimary, lineHeight: 21 },
  stance: { fontSize: 15, fontWeight: '700', color: colors.textPrimary, marginBottom: 6 },
  subLabel: { fontSize: 12.5, fontWeight: '700', color: colors.textMuted, marginTop: 14, marginBottom: 8 },
  strip: { marginTop: 4 },
  photo: { width: 104, height: 104, borderRadius: 12, marginRight: 8, backgroundColor: colors.divider },
  note: { fontSize: 13, color: colors.textSecondary, lineHeight: 19, marginTop: 10 },

  input: {
    borderWidth: 1, borderColor: colors.divider, borderRadius: 14,
    padding: 14, minHeight: 110, textAlignVertical: 'top',
    // 16px at the small end: iOS Safari and the RN keyboard both punch the viewport
    // below it. Same rule as every other input in the product.
    fontSize: 16, color: colors.textPrimary, backgroundColor: colors.background,
  },
  addPhotos: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  addPhotosText: { fontSize: 14.5, fontWeight: '600', color: colors.primary },

  row: { flexDirection: 'row', gap: 10, marginTop: 12 },
  flex: { flex: 1 },
  primaryBtn: {
    backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 15,
    alignItems: 'center', justifyContent: 'center', minHeight: 48,
  },
  primaryBtnText: { color: '#fff', fontSize: 15.5, fontWeight: '700' },
  secondaryBtn: {
    borderWidth: 2, borderColor: colors.divider, borderRadius: 14, paddingVertical: 13,
    alignItems: 'center', justifyContent: 'center', minHeight: 48,
  },
  secondaryBtnText: { color: colors.textPrimary, fontSize: 15.5, fontWeight: '700' },
  disabled: { opacity: 0.6 },

  helpRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14 },
  helpText: { fontSize: 13.5, color: colors.textSecondary },
});
