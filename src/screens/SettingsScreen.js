import React, { useState, useMemo, useCallback } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet, Alert, Platform,
  Modal, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import ScreenHeader from '../components/ScreenHeader';
import { redeemPromoCode, normalizePromoCode } from '../lib/promoCodes';
import KeyboardDoneBar, { KEYBOARD_DONE_ID } from '../components/KeyboardDoneBar';
import { useAuth } from '../context/AuthContext';
import { useJobs } from '../context/JobsContext';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import { fetchMfaStatus } from '../lib/mfa';
import { colors, radii } from '../theme';

// The settings HUB. Everything a user can change lives here or one tap away, and the
// search filters across all of it — a flat list of 20-odd rows is unusable otherwise,
// which is why iOS/Android both ship search in Settings.
//
// The long profile form that used to BE this screen now lives in ProfileSettingsScreen
// behind the first row; this screen is navigation + the things that don't need a form.
export default function SettingsScreen({ navigation }) {
  const { signOut, user } = useAuth();
  const { getPaymentReadiness } = useJobs();
  const { showToast } = useUser();
  const haptic = useHaptic();
  const [q, setQ] = useState('');
  const [payReady, setPayReady] = useState(null);

  useFocusEffect(
    useCallback(() => {
      getPaymentReadiness().then(setPayReady).catch(() => {});
    }, [getPaymentReadiness]),
  );

  const go = (route, params) => { haptic.medium(); navigation.navigate(route, params); };

  // Signing out means re-verifying by email to get back in, so it asks first.
  const confirmSignOut = () => {
    haptic.medium();
    if (Platform.OS === 'web') {
      // Alert.alert's buttons are a no-op on react-native-web.
      if (typeof window !== 'undefined' && window.confirm?.('Sign out of GoHustlr?')) signOut();
      return;
    }
    Alert.alert('Sign out?', "You'll need to sign in again to get back to your gigs.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: signOut },
    ]);
  };

  // Whether two-factor is on belongs in the row itself: "Security" alone tells you
  // nothing, and the whole reason to surface it is so someone notices it is OFF.
  const [mfaOn, setMfaOn] = useState(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeErr, setCodeErr] = useState(null);
  useFocusEffect(useCallback(() => {
    let alive = true;
    fetchMfaStatus()
      .then((st) => { if (alive) setMfaOn(st.enabled); })
      .catch(() => { if (alive) setMfaOn(null); });
    return () => { alive = false; };
  }, []));
  const mfaSub = mfaOn === null
    ? 'Two-factor authentication'
    : mfaOn ? 'Two-factor is on' : 'Two-factor is off — recommended';

  // Payments subtitle mirrors the You tab's banner so the two never disagree.
  const paymentsSub = !payReady
    ? 'Payout account & card on file'
    : payReady.payoutReady && payReady.paymentMethodReady
      ? 'Payouts active · card on file'
      : payReady.payout?.state === 'pending'
        ? 'Stripe is verifying your details'
        : !payReady.payoutReady
          ? 'Finish payout setup to get paid'
          : 'Add a card so you can hire';

  // `keywords` widens what a row matches without cluttering its label — searching
  // "password", "delete", "1099" or "terms" should all land somewhere sensible.
  const GROUPS = [
    {
      title: 'Account',
      rows: [
        { icon: 'person-circle-outline', title: 'Profile settings',
          sub: 'Photo, name, bio, skills, college, availability radius',
          keywords: 'avatar picture username role location skills major graduation certifications date of birth',
          onPress: () => go('ProfileSettings') },
        { icon: 'shield-checkmark-outline', title: 'Security',
          sub: mfaSub,
          keywords: 'two factor 2fa mfa authenticator totp password security login recovery codes',
          onPress: () => go('Security') },
        { icon: 'time-outline', title: 'Availability & schedule',
          sub: 'Work status, hours & classes',
          keywords: 'busy hours calendar classes schedule status',
          onPress: () => go('Availability') },
        { icon: 'eye-outline', title: 'View my public profile',
          sub: 'See exactly how others see you',
          keywords: 'public preview others reviews',
          onPress: () => { if (user) go('UserProfile', { userId: user.id }); } },
      ],
    },
    {
      title: 'Money',
      rows: [
        { icon: 'swap-vertical-outline', title: 'Transactions',
          sub: 'Receipts, fees, refunds & escrow',
          keywords: 'history statement receipts transactions payments spending earnings escrow refund invoice csv declined charge',
          onPress: () => go('Payments') },
        { icon: 'card-outline', title: 'Payments & payouts', sub: paymentsSub,
          keywords: 'stripe bank card payout method money withdraw deposit account',
          onPress: () => go('PayoutSetup') },
        { icon: 'receipt-outline', title: 'Tax Center',
          sub: 'Track expenses & export for taxes',
          keywords: 'tax 1099 expenses mileage receipts income export csv',
          onPress: () => go('Expenses') },
        // The redemption entry point. redeem_promo_code has been granted to
        // `authenticated` since promotions shipped and had zero callers, so every code
        // the console minted was a dead string.
        { icon: 'pricetag-outline', title: 'Have a code?',
          sub: 'Redeem a promo or referral code',
          keywords: 'promo code coupon referral discount voucher offer redeem claim',
          onPress: () => setCodeOpen(true) },
      ],
    },
    {
      title: 'Notifications',
      rows: [
        { icon: 'options-outline', title: 'Notification settings',
          sub: 'Push & email preferences',
          keywords: 'push email alerts mute preferences',
          onPress: () => go('NotificationSettings') },
        { icon: 'notifications-outline', title: 'Alerts inbox',
          sub: 'Booking updates & gig matches',
          keywords: 'inbox unread messages updates',
          onPress: () => go('Notifications') },
      ],
    },
    {
      title: 'Saved',
      rows: [
        { icon: 'bookmark-outline', title: 'Saved gigs', sub: "Gigs you've bookmarked",
          keywords: 'bookmarks favourites favorites later', onPress: () => go('SavedGigs') },
        { icon: 'heart-outline', title: 'Saved people', sub: "Workers & clients you've favorited",
          keywords: 'favourites favorites people workers clients', onPress: () => go('Favorites') },
      ],
    },
    {
      title: 'Legal & support',
      rows: [
        { icon: 'document-text-outline', title: 'Terms of Service', keywords: 'legal terms agreement',
          onPress: () => go('Legal', { doc: 'terms' }) },
        { icon: 'lock-closed-outline', title: 'Privacy Policy', keywords: 'legal privacy data gdpr',
          onPress: () => go('Legal', { doc: 'privacy' }) },
        { icon: 'briefcase-outline', title: 'Independent Contractor Agreement',
          keywords: 'legal contractor 1099 employment classification',
          onPress: () => go('Legal', { doc: 'contractor' }) },
        // Opens the SAME thread as the Messages pin. "We reply by email" was true of
        // the old one-way sheet and is now actively misleading: the reply arrives in
        // the app, and someone told to watch their inbox will not see it.
        { icon: 'chatbubble-ellipses-outline', title: 'Contact support', sub: 'Chat with a real person',
          keywords: 'help email problem report bug ticket chat message',
          onPress: () => go('Support') },
      ],
    },
    {
      title: 'Account actions',
      rows: [
        // Sign out is the ONLY account action at this level. Deleting your
        // account is deliberately not a row here — it lives at the bottom of
        // Profile settings, behind a typed confirmation, so it can't be reached
        // by scrolling to the end of the settings list and tapping the last
        // red thing. Search still finds it (see the keywords below).
        { icon: 'log-out-outline', title: 'Sign out', danger: true, keywords: 'logout log out leave',
          onPress: () => confirmSignOut() },
        { icon: 'person-circle-outline', title: 'Manage your account',
          sub: 'Profile details, and closing your account',
          keywords: 'delete remove close erase gdpr account deletion',
          onPress: () => go('ProfileSettings') },
      ],
    },
  ];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return GROUPS;
    return GROUPS
      .map(g => ({
        ...g,
        rows: g.rows.filter(r =>
          `${r.title} ${r.sub || ''} ${r.keywords || ''} ${g.title}`.toLowerCase().includes(needle)),
      }))
      .filter(g => g.rows.length > 0);
  }, [q, paymentsSub, mfaSub]);

  const nothing = filtered.length === 0;

  return (
    <View style={styles.container}>
      {/* No hand-rolled back button and no title here — both come from the native
          stack header now, so this screen's back control is the same one, in the
          same place, as every other screen in the app. */}
      <ScreenHeader topInset={false}>
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={17} color={colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search settings"
            placeholderTextColor={colors.textMuted}
            value={q}
            onChangeText={setQ}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            inputAccessoryViewID={KEYBOARD_DONE_ID}
          />
          {q.length > 0 && (
            <TouchableOpacity onPress={() => setQ('')} hitSlop={10} accessibilityLabel="Clear search">
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </ScreenHeader>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 140 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {nothing ? (
          <View style={styles.empty}>
            <Ionicons name="search-outline" size={30} color={colors.textMuted} />
            <Text style={styles.emptyTitle} numberOfLines={2}>No settings match “{q}”</Text>
            <Text style={styles.emptySub}>Try a different word, like “payout”, “notifications” or “privacy”.</Text>
          </View>
        ) : filtered.map(group => (
          <View key={group.title} style={styles.group}>
            <Text style={styles.groupTitle}>{group.title}</Text>
            <View style={styles.card}>
              {group.rows.map((r, i) => (
                <Row key={r.title} {...r} last={i === group.rows.length - 1} />
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
      <KeyboardDoneBar />
      <Modal visible={codeOpen} transparent animationType="slide" onRequestClose={() => setCodeOpen(false)}>
        <View style={styles.codeBackdrop}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setCodeOpen(false)} />
          <View style={styles.codeSheet}>
            <Text style={styles.codeTitle}>Have a code?</Text>
            <Text style={styles.codeSub}>
              Promo and referral codes are claimed once and apply automatically to your next
              eligible gig.
            </Text>
            <TextInput
              value={code}
              onChangeText={(t) => { setCode(normalizePromoCode(t)); setCodeErr(null); }}
              placeholder="ENTER CODE"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              style={styles.codeInput}
            />
            {codeErr ? <Text style={styles.codeErr}>{codeErr}</Text> : null}
            <TouchableOpacity
              style={[styles.codeBtn, (!code || codeBusy) && { opacity: 0.45 }]}
              disabled={!code || codeBusy}
              onPress={async () => {
                setCodeBusy(true); setCodeErr(null);
                try {
                  const ok = await redeemPromoCode(code);
                  if (ok) {
                    setCodeOpen(false); setCode('');
                    showToast?.({ icon: '🎁', title: 'Code applied!', message: 'It will apply to your next eligible gig.' });
                  } else {
                    // ONE message for every failure. The RPC returns a bare boolean on
                    // purpose — distinct errors would tell someone probing which codes
                    // exist — so the UI must not invent detail the server withheld.
                    setCodeErr("That code isn't available. Check it and try again.");
                  }
                } finally { setCodeBusy(false); }
              }}
            >
              {codeBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.codeBtnText}>Apply code</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Row({ icon, title, sub, onPress, danger, last }) {
  return (
    <TouchableOpacity
      style={[styles.row, last && styles.rowLast]}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
    >
      <View style={[styles.rowIcon, danger && styles.rowIconDanger]}>
        <Ionicons name={icon} size={18} color={danger ? colors.urgent : colors.primary} />
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, danger && styles.rowTitleDanger]} numberOfLines={1}>{title}</Text>
        {!!sub && <Text style={styles.rowSub} numberOfLines={2}>{sub}</Text>}
      </View>
      <Ionicons name="chevron-forward" size={17} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  codeBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  codeSheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    padding: 22, paddingBottom: 34,
  },
  codeTitle: { fontSize: 20, fontWeight: '800', color: colors.textPrimary },
  codeSub: { fontSize: 13.5, color: colors.textSecondary, marginTop: 6, lineHeight: 20 },
  codeInput: {
    marginTop: 16, backgroundColor: colors.background, borderRadius: radii.lg,
    paddingVertical: 14, paddingHorizontal: 16, fontSize: 18, letterSpacing: 2,
    textAlign: 'center', color: colors.textPrimary, fontWeight: '700',
  },
  codeErr: { fontSize: 13, color: colors.urgent, marginTop: 10, textAlign: 'center' },
  codeBtn: {
    marginTop: 16, backgroundColor: colors.primary, borderRadius: radii.pill,
    paddingVertical: 15, alignItems: 'center',
  },
  codeBtnText: { color: '#fff', fontWeight: '800', fontSize: 16 },

  container: { flex: 1, backgroundColor: colors.background },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.surface, borderRadius: radii.pill,
    paddingHorizontal: 14, height: 44,
    borderWidth: 1, borderColor: colors.border,
  },
  searchInput: { flex: 1, fontSize: 15, color: colors.textPrimary, paddingVertical: 0 },

  group: { paddingHorizontal: 20, marginTop: 22 },
  groupTitle: {
    fontSize: 12, fontWeight: '700', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8, marginLeft: 4,
  },
  card: { backgroundColor: colors.surface, borderRadius: radii.lg, overflow: 'hidden' },
  row: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  rowLast: { borderBottomWidth: 0 },
  rowIcon: {
    width: 34, height: 34, borderRadius: radii.md, marginRight: 12,
    backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center',
  },
  rowIconDanger: { backgroundColor: colors.urgentLight },
  rowText: { flex: 1, marginRight: 10 },
  rowTitle: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  rowTitleDanger: { color: colors.urgent },
  rowSub: { fontSize: 13, color: colors.textMuted, marginTop: 2, lineHeight: 17 },

  empty: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 40 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: colors.textPrimary, marginTop: 12, textAlign: 'center' },
  emptySub: { fontSize: 13, color: colors.textMuted, marginTop: 6, textAlign: 'center', lineHeight: 18 },
});
