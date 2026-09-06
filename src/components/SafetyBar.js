import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, Share, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { colors, radii } from '../theme';
import { useHaptic } from '../hooks/useHaptic';

// Safety controls for a gig that is happening right now.
//
// Shown only on a booking the earner has STARTED — before that there is nothing to
// share and nobody to be worried about, and a safety bar on every card would become
// furniture people stop seeing.
//
// Two actions, deliberately different in weight:
//   SHARE      one tap, no confirmation. Friction here means it does not get used, and
//              an unused safety feature is the same as an absent one.
//   EMERGENCY  a confirm step, because a mis-tap files a real report and pages a real
//              person — but the confirm is one tap and the wording does not scold.

const SHARE_HOURS = 12;

// The token is minted SERVER-SIDE by create_gig_share, not here.
//
// This used to build it from Math.random() — a fast non-cryptographic PRNG with a small
// internal state, not a CSPRNG. That token is the sole credential for a page showing the
// gig's exact street address and the earner's live status, so it is generated with
// gen_random_bytes instead. The server also owns the expiry, which is capped at 24h;
// the client cannot choose either value, and INSERT on gig_shares is revoked.

export default function SafetyBar({ booking, siteUrl = 'https://gohustlr.com' }) {
  const haptic = useHaptic();
  const [busy, setBusy] = useState(null);
  // Is there a link out there right now? The Terms and the Privacy Policy both tell
  // posters the earner "can revoke it at any time" — and until this state existed no
  // client offered any way to. The schema always did (gig_shares_revoke_own), so the
  // promise was one screen away from being true and nobody could reach it.
  const [liveShare, setLiveShare] = useState(false);

  const refreshLiveShare = useCallback(async () => {
    // gig_shares_own scopes SELECT to created_by = auth.uid(), so this can only ever
    // see the caller's own links.
    const { data } = await supabase
      .from('gig_shares')
      .select('id')
      .eq('booking_id', booking.id)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString())
      .limit(1);
    setLiveShare((data?.length ?? 0) > 0);
  }, [booking.id]);

  useEffect(() => { refreshLiveShare(); }, [refreshLiveShare]);

  const share = async () => {
    setBusy('share');
    try {
      // INSIDE the try, and called as a method.
      //
      // This was `haptic('light')` sitting ABOVE the try. useHaptic returns an OBJECT
      // ({ light, medium, ... }) — every other caller in the app uses haptic.light() —
      // so calling it as a function threw TypeError synchronously, outside the try,
      // before the RPC ever ran. The result was a button that spun forever, minted no
      // link, and never surfaced an error. A cosmetic buzz must never be able to break
      // the action it decorates, least of all this one.
      haptic.light?.();
      // One call does everything the client used to do by hand: it authorises the
      // caller, hands back an existing live link if there is one, and otherwise mints
      // a fresh token and expiry. Reusing a live link matters — someone who sends it to
      // their housemate and then their mum must be sending the SAME link, or revoking
      // one leaves the other quietly live — and doing that server-side makes it
      // authoritative rather than advisory.
      const { data: token, error } = await supabase.rpc('create_gig_share', {
        p_booking: booking.id,
        p_hours: SHARE_HOURS,
      });
      if (error) throw error;
      if (!token) throw new Error('Could not create a link for this gig.');

      setLiveShare(true);
      await Share.share({
        message:
          `I'm working a GoHustlr gig right now. You can see where I am and when I'm ` +
          `due to finish here: ${siteUrl}/s/${token}`,
      });
    } catch (e) {
      Alert.alert('Could not share', e?.message ?? 'Please try again.');
    } finally {
      setBusy(null);
    }
  };

  // The other half of the share. A link that can only end when it expires is not the
  // control the consent documents describe: the person the earner shared with can
  // become the person they are worried about, or the link lands in the wrong group
  // chat — and until it expires it keeps showing the poster's exact street address,
  // both first names and live status.
  const stopSharing = () => {
    haptic.light?.();
    Alert.alert(
      'Stop sharing this gig?',
      'The link stops working straight away. Anyone you sent it to will no longer see '
        + 'where you are. You can share a new link any time.',
      [
        { text: 'Keep sharing', style: 'cancel' },
        {
          text: 'Stop sharing',
          style: 'destructive',
          onPress: async () => {
            setBusy('revoke');
            try {
              // Every live link for this booking, not just the newest — create_gig_share
              // reuses a live token, but an older row can still exist from before that
              // behaviour, and "stop sharing" that leaves one alive is worse than none.
              // gig_shares_revoke_own scopes the UPDATE to the caller's own rows.
              const { error } = await supabase
                .from('gig_shares')
                .update({ revoked_at: new Date().toISOString() })
                .eq('booking_id', booking.id)
                .is('revoked_at', null);
              if (error) throw error;
              setLiveShare(false);
              Alert.alert('Sharing stopped', 'That link no longer works.');
            } catch (e) {
              Alert.alert('Could not stop sharing', e?.message ?? 'Please try again.');
            } finally {
              setBusy(null);
              refreshLiveShare();
            }
          },
        },
      ],
    );
  };

  const emergency = () => {
    // Same bug, worse consequence: this was `haptic('warning')` as the first statement,
    // so the TypeError meant the confirmation dialog never opened and the SOS button did
    // nothing whatsoever. ('warning' was not even a valid key — the object exposes
    // `error`.) Optional-call so a haptics failure can never swallow the alarm.
    haptic.error?.();
    Alert.alert(
      'Get help now?',
      'This alerts the GoHustlr safety team immediately with your gig details. ' +
        'If you are in danger, call your local emergency number first.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Alert GoHustlr',
          style: 'destructive',
          onPress: async () => {
            setBusy('sos');
            try {
              const { error } = await supabase.rpc('raise_gig_emergency', {
                p_booking: booking.id,
                p_note: 'Emergency raised from the active gig screen.',
              });
              if (error) throw error;
              Alert.alert(
                'Help is being alerted',
                'Our safety team has been notified. Keep this screen open if you can.',
              );
            } catch (e) {
              Alert.alert('Could not send', e?.message ?? 'Please call for help directly.');
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );
  };

  return (
    <View>
      <View style={styles.wrap}>
        <TouchableOpacity style={styles.shareBtn} onPress={share} disabled={busy === 'share'}>
          {busy === 'share'
            ? <ActivityIndicator size="small" color={colors.primary} />
            : <Ionicons name="location-outline" size={15} color={colors.primary} />}
          <Text style={styles.shareText} numberOfLines={1}>
            {liveShare ? 'Share again' : 'Share my gig'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.sosBtn} onPress={emergency} disabled={busy === 'sos'}>
          {busy === 'sos'
            ? <ActivityIndicator size="small" color={colors.urgent} />
            : <Ionicons name="alert-circle-outline" size={15} color={colors.urgent} />}
          <Text style={styles.sosText} numberOfLines={1}>Get help</Text>
        </TouchableOpacity>
      </View>

      {/* Only while a link is actually live. An always-present "stop sharing" on a gig
          nobody shared is furniture; here it appears exactly when it means something. */}
      {liveShare && (
        <TouchableOpacity style={styles.revokeBtn} onPress={stopSharing} disabled={busy === 'revoke'}>
          {busy === 'revoke'
            ? <ActivityIndicator size="small" color={colors.textSecondary} />
            : <Ionicons name="eye-off-outline" size={14} color={colors.textSecondary} />}
          <Text style={styles.revokeText} numberOfLines={1}>Stop sharing my location</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', gap: 8, marginTop: 10 },
  shareBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, borderRadius: radii.md,
    backgroundColor: colors.primaryLight,
  },
  shareText: { fontSize: 13, fontWeight: '700', color: colors.primary },
  sosBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, paddingHorizontal: 14, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.urgent,
  },
  sosText: { fontSize: 13, fontWeight: '700', color: colors.urgent },
  revokeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 8, marginTop: 6,
  },
  revokeText: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
});
