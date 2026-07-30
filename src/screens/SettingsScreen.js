import React, { useState, useMemo, useCallback } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet, Linking, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import ScreenHeader from '../components/ScreenHeader';
import KeyboardDoneBar, { KEYBOARD_DONE_ID } from '../components/KeyboardDoneBar';
import { SUPPORT_EMAIL } from '../lib/legal';
import { useAuth } from '../context/AuthContext';
import { useJobs } from '../context/JobsContext';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
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
        { icon: 'card-outline', title: 'Payments & payouts', sub: paymentsSub,
          keywords: 'stripe bank card payout money withdraw earnings deposit',
          onPress: () => go('PayoutSetup') },
        { icon: 'receipt-outline', title: 'Tax Center',
          sub: 'Track expenses & export for taxes',
          keywords: 'tax 1099 expenses mileage receipts income export csv',
          onPress: () => go('Expenses') },
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
        { icon: 'mail-outline', title: 'Contact support', sub: SUPPORT_EMAIL,
          keywords: 'help email problem report bug',
          onPress: () => Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=GoHustlr%20Support`) },
      ],
    },
    {
      title: 'Account actions',
      rows: [
        { icon: 'log-out-outline', title: 'Sign out', danger: true, keywords: 'logout log out leave',
          onPress: () => { haptic.medium(); signOut(); } },
        { icon: 'trash-outline', title: 'Delete account', danger: true,
          sub: 'Permanently remove your account and data',
          keywords: 'delete remove close erase gdpr',
          onPress: () => go('ProfileSettings', { scrollTo: 'danger' }) },
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
  }, [q, paymentsSub]);

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
