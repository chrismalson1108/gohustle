import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, ScrollView,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as WebBrowser from 'expo-web-browser';
import { Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useStripe } from '@stripe/stripe-react-native';
import { useJobs } from '../context/JobsContext';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import { colors, shadows } from '../theme';

// Unified "GoHustlr Payments" hub — always reachable from Profile so users can
// add, edit, change, or remove their payment info at any time. Two role-aware cards:
//   • Get paid for work  → connect / manage a bank for payouts (earner)
//   • Pay for gigs        → add / change / remove a card on file (poster)
// Stripe is the invisible processor — surfaced only as a small trust line.
export default function PayoutSetupScreen({ navigation }) {
  const {
    getPayoutOnboardingUrl, getPayoutStatus, getPayoutLoginLink,
    createSetupIntent, getPaymentMethodStatus, detachPaymentMethod,
  } = useJobs();
  const { role, showToast } = useUser();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const haptic = useHaptic();
  const insets = useSafeAreaInsets();

  // Everyone can both earn and hire, so always show both setup cards.
  const showEarn = true;
  const showPay  = true;

  const [payout, setPayout]     = useState(null); // { hasAccount, onboarded }
  const [cardInfo, setCardInfo] = useState(null); // { hasPaymentMethod, brand, last4 }
  const [loadingPayout, setLoadingPayout] = useState(false);
  const [loadingCard, setLoadingCard]     = useState(false);

  const refresh = useCallback(async () => {
    if (showEarn) setPayout(await getPayoutStatus());
    if (showPay)  setCardInfo(await getPaymentMethodStatus());
  }, [showEarn, showPay]);

  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  // ── Earner: connect a bank for payouts (hosted onboarding for now) ──
  const handleConnectPayout = async () => {
    haptic.medium();
    setLoadingPayout(true);
    try {
      const result = await getPayoutOnboardingUrl();
      if (result.alreadyOnboarded) {
        await refresh();
        setLoadingPayout(false);
        return;
      }
      await WebBrowser.openBrowserAsync(result.url, {
        toolbarColor: colors.primary,
        controlsColor: '#fff',
      });
      await refresh();
    } catch (err) {
      showToast({ icon: '⚠️', title: "Couldn't start payout setup", message: err.message || 'Please try again.' });
    }
    setLoadingPayout(false);
  };

  // ── Earner: manage/update existing payout (bank) details ──
  const handleManagePayout = async () => {
    haptic.medium();
    setLoadingPayout(true);
    try {
      const { url } = await getPayoutLoginLink();
      await WebBrowser.openBrowserAsync(url, { toolbarColor: colors.primary, controlsColor: '#fff' });
      await refresh();
    } catch (err) {
      showToast({ icon: '⚠️', title: "Couldn't open payout settings", message: err.message || 'Please try again.' });
    }
    setLoadingPayout(false);
  };

  // ── Poster: add or change the card on file (in-app SetupIntent PaymentSheet) ──
  const handleAddOrChangeCard = async () => {
    haptic.medium();
    setLoadingCard(true);
    try {
      const { setupIntentClientSecret, customerId, ephemeralKey } = await createSetupIntent();
      const { error: initErr } = await initPaymentSheet({
        merchantDisplayName: 'GoHustlr',
        customerId,
        customerEphemeralKeySecret: ephemeralKey,
        setupIntentClientSecret,
        appearance: { colors: { primary: colors.primary } },
      });
      if (initErr) throw new Error(initErr.message);

      const { error: payErr } = await presentPaymentSheet();
      if (payErr) {
        if (payErr.code !== 'Canceled') {
          showToast({ icon: '❌', title: 'Error', message: payErr.message });
        }
      } else {
        haptic.success();
        showToast({ icon: '✅', title: cardDone ? 'Card Updated' : 'Payment Method Added', message: 'You can now hire and pay earners.' });
        await refresh();
      }
    } catch (err) {
      showToast({ icon: '⚠️', title: "Couldn't open payment methods", message: err.message || 'Please try again.' });
    }
    setLoadingCard(false);
  };

  // ── Poster: remove the card on file ──
  const handleRemoveCard = () => {
    haptic.medium();
    Alert.alert(
      'Remove card?',
      'You won\'t be able to accept bookings until you add a payment method again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive',
          onPress: async () => {
            setLoadingCard(true);
            try {
              await detachPaymentMethod();
              haptic.success();
              showToast({ icon: '🗑️', title: 'Card Removed', message: 'Add a new one anytime to hire again.' });
              await refresh();
            } catch (err) {
              showToast({ icon: '⚠️', title: "Couldn't remove card", message: err.message || 'Please try again.' });
            }
            setLoadingCard(false);
          },
        },
      ],
    );
  };

  const payoutDone = payout?.onboarded;
  const cardDone   = cardInfo?.hasPaymentMethod === true;
  const cardLabel  = cardDone
    ? `${(cardInfo.brand || 'card').charAt(0).toUpperCase() + (cardInfo.brand || 'card').slice(1)} •••• ${cardInfo.last4 || '----'}`
    : null;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <LinearGradient colors={['#6D28D9', '#4F46E5']} style={styles.hero}>
        <View style={styles.heroIcon}>
          <Ionicons name="card" size={44} color="#fff" />
        </View>
        <Text style={styles.heroTitle}>GoHustlr Payments</Text>
        <Text style={styles.heroSub}>
          Get paid for work and pay for gigs — all securely inside GoHustlr.
        </Text>
      </LinearGradient>

      {/* Get paid (earner) */}
      {showEarn && (
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Ionicons name="wallet" size={20} color={colors.primary} />
            <Text style={styles.sectionTitle}>Get paid for work</Text>
            {payoutDone && <View style={styles.donePill}><Text style={styles.donePillText}>Active</Text></View>}
          </View>
          {payoutDone ? (
            <>
              <View style={styles.successRow}>
                <Ionicons name="shield-checkmark" size={18} color={colors.success} />
                <Text style={styles.successText}>
                  Your bank is connected. Earnings (minus the 10% fee) deposit automatically 1–2 business days after a job is verified.
                </Text>
              </View>
              <TouchableOpacity style={styles.btnOutline} onPress={handleManagePayout} disabled={loadingPayout} activeOpacity={0.8}>
                {loadingPayout ? <ActivityIndicator color={colors.primary} /> : (
                  <Text style={styles.btnOutlineText}>Manage payout details</Text>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.sectionDesc}>
                Connect a bank account so you can receive payments after completing jobs. Takes about a minute.
              </Text>
              <TouchableOpacity style={styles.btn} onPress={handleConnectPayout} disabled={loadingPayout} activeOpacity={0.85}>
                {loadingPayout ? <ActivityIndicator color="#fff" /> : (
                  <Text style={styles.btnText}>
                    {payout?.hasAccount ? 'Continue setup' : 'Connect bank account'}
                  </Text>
                )}
              </TouchableOpacity>
            </>
          )}
        </View>
      )}

      {/* Pay for gigs (poster) */}
      {showPay && (
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Ionicons name="card-outline" size={20} color={colors.primary} />
            <Text style={styles.sectionTitle}>Pay for gigs</Text>
            {cardDone && <View style={styles.donePill}><Text style={styles.donePillText}>Ready</Text></View>}
          </View>

          {cardDone ? (
            <>
              <View style={styles.cardRow}>
                <Ionicons name="card" size={20} color={colors.textPrimary} />
                <Text style={styles.cardLabel}>{cardLabel}</Text>
              </View>
              <Text style={styles.sectionDesc}>
                When you accept a booking, the amount is held securely and only charged after you verify the work.
              </Text>
              <TouchableOpacity style={styles.btnOutline} onPress={handleAddOrChangeCard} disabled={loadingCard} activeOpacity={0.8}>
                {loadingCard ? <ActivityIndicator color={colors.primary} /> : (
                  <Text style={styles.btnOutlineText}>Change card</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnDanger} onPress={handleRemoveCard} disabled={loadingCard} activeOpacity={0.8}>
                <Text style={styles.btnDangerText}>Remove card</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.sectionDesc}>
                Add a payment method so you can hire. You're only charged when you accept a booking, and funds are held until you confirm the job is done.
              </Text>
              <TouchableOpacity style={styles.btn} onPress={handleAddOrChangeCard} disabled={loadingCard} activeOpacity={0.85}>
                {loadingCard ? <ActivityIndicator color="#fff" /> : (
                  <Text style={styles.btnText}>Add a payment method</Text>
                )}
              </TouchableOpacity>
            </>
          )}
        </View>
      )}

      {/* Tax reassurance */}
      <View style={styles.infoCard}>
        <Ionicons name="document-text-outline" size={18} color={colors.primary} />
        <Text style={styles.infoText}>
          We handle your tax forms — eligible earners get a 1099 automatically, so you don't have to track it yourself.
        </Text>
      </View>

      {/* Trust note */}
      <View style={styles.trustRow}>
        <Ionicons name="lock-closed" size={13} color={colors.textMuted} />
        <Text style={styles.trustText}>
          Bank-grade security. Payments securely processed by Stripe — GoHustlr never stores your card or bank details.
        </Text>
      </View>

      {/* Always-available exit so users can never get stuck here */}
      <TouchableOpacity
        style={styles.btnGhost}
        onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('ProfileMain'))}
        activeOpacity={0.8}
      >
        <Text style={styles.btnGhostText}>Done</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 20, paddingTop: 0 },

  hero: {
    borderRadius: 20,
    padding: 28,
    marginBottom: 20,
    alignItems: 'center',
    marginTop: 12,
  },
  heroIcon: {
    width: 76, height: 76, borderRadius: 38,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 14,
  },
  heroTitle: { color: '#fff', fontSize: 22, fontWeight: '800', marginBottom: 8 },
  heroSub: { color: 'rgba(255,255,255,0.85)', fontSize: 14, textAlign: 'center', lineHeight: 20 },

  section: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    ...shadows.card,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: colors.textPrimary, flex: 1 },
  sectionDesc: { fontSize: 13.5, color: colors.textSecondary, lineHeight: 20, marginBottom: 16 },

  donePill: { backgroundColor: colors.accentLight, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  donePillText: { color: colors.success, fontSize: 12, fontWeight: '800' },

  successRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginBottom: 14 },
  successText: { flex: 1, fontSize: 13.5, color: colors.textSecondary, lineHeight: 20 },

  cardRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.background,
    borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14,
    marginBottom: 12,
  },
  cardLabel: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },

  btn: {
    backgroundColor: colors.primary,
    borderRadius: 14, height: 52,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    ...shadows.md,
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '800' },

  btnOutline: {
    borderRadius: 14, height: 50,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: colors.primary,
  },
  btnOutlineText: { color: colors.primary, fontSize: 15, fontWeight: '700' },

  btnDanger: { height: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  btnDangerText: { color: colors.urgent, fontSize: 14, fontWeight: '700' },

  infoCard: {
    flexDirection: 'row', gap: 10, alignItems: 'flex-start',
    backgroundColor: colors.primaryLight,
    borderRadius: 14, padding: 16, marginBottom: 16,
  },
  infoText: { flex: 1, fontSize: 13, color: colors.textPrimary, lineHeight: 19 },

  trustRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginBottom: 20, paddingHorizontal: 4 },
  trustText: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 17 },

  btnGhost: { height: 48, alignItems: 'center', justifyContent: 'center' },
  btnGhostText: { color: colors.textSecondary, fontSize: 15, fontWeight: '700' },
});
