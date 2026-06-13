import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, ScrollView,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as WebBrowser from 'expo-web-browser';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useJobs } from '../context/JobsContext';
import { useHaptic } from '../hooks/useHaptic';
import { colors, shadows } from '../theme';

export default function PayoutSetupScreen({ navigation }) {
  const { getPayoutOnboardingUrl, getPayoutStatus } = useJobs();
  const haptic = useHaptic();
  const insets = useSafeAreaInsets();

  const [status, setStatus]   = useState(null); // null | { hasAccount, onboarded }
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    checkStatus();
  }, []);

  const checkStatus = async () => {
    const s = await getPayoutStatus();
    setStatus(s);
  };

  const handleSetup = async () => {
    haptic.medium();
    setLoading(true);
    try {
      const result = await getPayoutOnboardingUrl();

      if (result.alreadyOnboarded) {
        await checkStatus();
        setLoading(false);
        return;
      }

      // Open Stripe's hosted Connect onboarding in the browser
      await WebBrowser.openBrowserAsync(result.url, {
        toolbarColor: colors.primary,
        controlsColor: '#fff',
      });

      // When the user returns to the app, refresh the status
      await checkStatus();
    } catch (err) {
      console.warn('Payout setup error:', err.message);
    }
    setLoading(false);
  };

  const isOnboarded = status?.onboarded;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <LinearGradient colors={['#6D28D9', '#4F46E5']} style={styles.hero}>
        <View style={styles.heroIcon}>
          <Ionicons name={isOnboarded ? 'checkmark-circle' : 'wallet'} size={48} color="#fff" />
        </View>
        <Text style={styles.heroTitle}>
          {isOnboarded ? 'Payouts Active' : 'Set Up Payouts'}
        </Text>
        <Text style={styles.heroSub}>
          {isOnboarded
            ? 'Your bank account is connected. Earnings are deposited automatically.'
            : 'Connect your bank account to receive payments after completing jobs.'}
        </Text>
      </LinearGradient>

      {/* How it works */}
      {!isOnboarded && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>How it works</Text>
          {STEPS.map((step, i) => (
            <View key={i} style={styles.step}>
              <View style={styles.stepNum}>
                <Text style={styles.stepNumText}>{i + 1}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.stepTitle}>{step.title}</Text>
                <Text style={styles.stepDesc}>{step.desc}</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Status card when onboarded */}
      {isOnboarded && (
        <View style={[styles.section, styles.successCard]}>
          <Ionicons name="shield-checkmark" size={24} color={colors.success} />
          <Text style={styles.successText}>
            Earnings will be deposited to your bank account 1–2 business days after each job is verified by the poster.
          </Text>
        </View>
      )}

      {/* Trust note */}
      <View style={styles.trustRow}>
        <Ionicons name="lock-closed" size={14} color={colors.textMuted} />
        <Text style={styles.trustText}>
          Powered by Stripe. GoHustlr never stores your bank details.
        </Text>
      </View>

      {/* Action button */}
      {!isOnboarded && (
        <TouchableOpacity
          style={styles.btn}
          onPress={handleSetup}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="card" size={18} color="#fff" style={{ marginRight: 8 }} />
              <Text style={styles.btnText}>
                {status?.hasAccount ? 'Continue Setup' : 'Connect Bank Account'}
              </Text>
            </>
          )}
        </TouchableOpacity>
      )}

      {isOnboarded && (
        <TouchableOpacity style={styles.btnOutline} onPress={() => navigation.goBack()} activeOpacity={0.8}>
          <Text style={styles.btnOutlineText}>Back to Profile</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const STEPS = [
  {
    title: 'Connect via Stripe',
    desc: 'You\'ll be taken to Stripe\'s secure form to enter your bank account details.',
  },
  {
    title: 'Complete jobs',
    desc: 'After both you and the poster confirm completion, the poster verifies your work.',
  },
  {
    title: 'Get paid automatically',
    desc: 'Earnings (minus the 10% GoHustlr fee) are deposited in 1–2 business days.',
  },
];

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 20, paddingTop: 0 },

  hero: {
    borderRadius: 20,
    padding: 28,
    marginBottom: 24,
    alignItems: 'center',
    marginTop: 12,
  },
  heroIcon: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 16,
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
  sectionTitle: { fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: 16 },

  step: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 16 },
  stepNum: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
    marginRight: 12, marginTop: 1,
  },
  stepNumText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  stepTitle: { fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: 2 },
  stepDesc: { fontSize: 13, color: colors.textMuted, lineHeight: 18 },

  successCard: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  successText: { flex: 1, fontSize: 14, color: colors.text, lineHeight: 20 },

  trustRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 20, paddingHorizontal: 4 },
  trustText: { fontSize: 12, color: colors.textMuted },

  btn: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.md,
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '800' },

  btnOutline: {
    borderRadius: 14, height: 52,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: colors.primary,
  },
  btnOutlineText: { color: colors.primary, fontSize: 15, fontWeight: '700' },
});
