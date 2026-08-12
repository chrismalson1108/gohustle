import React, { useState } from 'react';
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

  const share = async () => {
    setBusy('share');
    haptic('light');
    try {
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

  const emergency = () => {
    haptic('warning');
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
    <View style={styles.wrap}>
      <TouchableOpacity style={styles.shareBtn} onPress={share} disabled={busy === 'share'}>
        {busy === 'share'
          ? <ActivityIndicator size="small" color={colors.primary} />
          : <Ionicons name="location-outline" size={15} color={colors.primary} />}
        <Text style={styles.shareText} numberOfLines={1}>Share my gig</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.sosBtn} onPress={emergency} disabled={busy === 'sos'}>
        {busy === 'sos'
          ? <ActivityIndicator size="small" color={colors.urgent} />
          : <Ionicons name="alert-circle-outline" size={15} color={colors.urgent} />}
        <Text style={styles.sosText} numberOfLines={1}>Get help</Text>
      </TouchableOpacity>
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
});
