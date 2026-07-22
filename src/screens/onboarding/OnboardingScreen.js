import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Dimensions, Animated, Platform, KeyboardAvoidingView, Keyboard, Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../context/AuthContext';
import { colors, radii } from '../../theme';
import { fetchCurrentDocs, recordAcceptances } from '../../lib/legal';
import { getReferralCode, recordReferral } from '../../lib/referrals';
import { parseDob, isAdult, MIN_AGE } from '../../lib/age';
import LocationPicker from '../../components/LocationPicker';
import DobPicker, { composeDob } from '../../components/DobPicker';

const { width } = Dimensions.get('window');

const ROLES = [
  { id: 'earner', label: 'Earner', ion: 'school',    desc: 'I want to find gigs and earn money' },
  { id: 'poster', label: 'Poster', ion: 'clipboard', desc: 'I want to post jobs and hire people' },
  { id: 'both',   label: 'Both',  ion: 'flash',      desc: 'I want to earn AND post jobs' },
];

const SKILL_OPTIONS = [
  'Lawn Care', 'Moving Help', 'Cleaning', 'Tutoring', 'Tech Help',
  'Delivery', 'Pet Care', 'Handyman', 'Photography', 'Writing',
  'Design', 'Cooking', 'Driving', 'Assembly', 'Painting',
  'Music', 'Fitness', 'Childcare', 'Errands', 'Other',
];

const RADIUS_OPTIONS = [5, 10, 15, 25, 50];


export default function OnboardingScreen({ onComplete }) {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState(0); // 0=welcome, 1=username, 2=role, 3=location, 4=skills/radius, 5=done
  const [form, setForm] = useState({
    username: '',
    dob: { month: null, day: null, year: null }, // Month/Day/Year dropdown parts
    role: '',
    city: '',
    skills: [],
    radiusMiles: 25,
    bio: '',
  });
  const [usernameError, setUsernameError] = useState('');
  const [dobError, setDobError] = useState('');
  const [saving, setSaving] = useState(false);
  const [finishError, setFinishError] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [legalDoc, setLegalDoc] = useState(null);  // 'terms'|'privacy'|'contractor'
  const [legalDocs, setLegalDocs] = useState({});

  // Email sign-ups accepted the legal terms via the signup checkbox; OAuth users
  // (Google) never saw one, so capture explicit consent on the final step before
  // handleFinish records their acceptance. Fail-safe: unknown provider → ask.
  const needsConsent = (user?.app_metadata?.provider || '') !== 'email';

  useEffect(() => {
    if (needsConsent) fetchCurrentDocs().then(setLegalDocs).catch(() => {});
  }, [needsConsent]);

  const slideAnim = useRef(new Animated.Value(0)).current;

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const toggleSkill = (skill) => {
    set('skills', form.skills.includes(skill)
      ? form.skills.filter(s => s !== skill)
      : [...form.skills, skill]);
  };

  const goNext = () => {
    Keyboard.dismiss();
    Animated.timing(slideAnim, { toValue: -(step + 1) * width, duration: 280, useNativeDriver: true }).start();
    setStep(s => s + 1);
  };

  const checkUsername = async () => {
    const u = form.username.trim().toLowerCase();
    if (!u || !/^[a-z0-9_]{3,30}$/.test(u)) {
      setUsernameError('3–30 characters, letters, numbers, underscores only');
      return false;
    }
    const { data } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', u)
      .neq('id', user.id)
      .maybeSingle();
    if (data) {
      setUsernameError('That username is already taken');
      return false;
    }
    setUsernameError('');
    return true;
  };

  // Age floor (H7): a valid, 18+ DOB is required to continue. The server also blocks
  // a known minor at action time (guard_min_age), but gate here for clear UX.
  const dobComplete = !!composeDob(form.dob);
  const checkDob = () => {
    const iso = parseDob(composeDob(form.dob));
    if (!iso) { setDobError('Select your date of birth.'); return false; }
    if (!isAdult(iso)) { setDobError(`You must be ${MIN_AGE} or older to use GoHustlr.`); return false; }
    setDobError('');
    return true;
  };

  const handleUsernameNext = async () => {
    const dobOk = checkDob();
    const ok = await checkUsername();
    if (ok && dobOk) goNext();
  };

  const handleFinish = async () => {
    Keyboard.dismiss();
    setSaving(true);
    setFinishError('');
    // Record acceptance of the current legal docs FIRST, and BLOCK on failure — the
    // account must not be marked onboarded until acceptance is durably stored (it is
    // the legal audit source of truth). recordAcceptances is idempotent, so retrying
    // after a later error is safe. Mirrors the web onboarding's fail-closed posture.
    // (email signups also consented at signup; OAuth signups consented via the
    // checkbox on this screen.)
    try {
      await recordAcceptances(user.id, await fetchCurrentDocs());
    } catch (_) {
      setSaving(false);
      setFinishError("Couldn't record your agreement to the terms — check your connection and try again.");
      return;
    }
    const { error } = await supabase.from('profiles').update({
      username: form.username.trim().toLowerCase(),
      date_of_birth: parseDob(composeDob(form.dob)),
      role: form.role,
      city: form.city,
      skills: form.skills,
      radius_miles: form.radiusMiles,
      bio: form.bio || null,
      onboarding_done: true,
    }).eq('id', user.id);
    if (error) {
      // Don't proceed as onboarded when the save failed — otherwise the user
      // enters the app half-set-up and gets bounced back here on next launch.
      setSaving(false);
      if (error.code === '23505') {
        // Username was claimed between the step-1 check and now.
        setUsernameError('That username was just taken — please pick another.');
        Animated.timing(slideAnim, { toValue: -1 * width, duration: 280, useNativeDriver: true }).start();
        setStep(1);
      } else {
        setFinishError("Couldn't save your profile. Check your connection and try again.");
      }
      return;
    }
    // Ensure a referral code exists + record who referred this user (from signup).
    try {
      await getReferralCode(user.id);
      const code = user.user_metadata?.referral_code;
      if (code) await recordReferral(user.id, code);
    } catch (_) {}
    setSaving(false);
    onComplete();
  };

  const STEPS = [
    // Step 0 — Welcome
    <View key="welcome" style={styles.stepWrap}>
      <Ionicons name="sparkles" size={56} color={colors.primary} style={styles.emoji} />
      <Text style={styles.stepTitle}>Welcome to GoHustlr!</Text>
      <Text style={styles.stepSub}>
        The gig marketplace for college students.{'\n'}
        Let's set up your profile in 60 seconds.
      </Text>
      <TouchableOpacity style={styles.nextBtn} onPress={goNext}>
        <View style={styles.nextBtnFill}>
          <Text style={styles.nextBtnText} numberOfLines={1}>Let's go</Text>
        </View>
      </TouchableOpacity>
    </View>,

    // Step 1 — Username
    <View key="username" style={styles.stepWrap}>
      <Ionicons name="pricetag" size={56} color={colors.primary} style={styles.emoji} />
      <Text style={styles.stepTitle}>Pick a username</Text>
      <Text style={styles.stepSub}>This is how others will see you on GoHustlr.</Text>
      <TextInput
        style={[styles.input, usernameError ? styles.inputError : null]}
        placeholder="e.g. chris_hustler"
        placeholderTextColor={colors.textMuted}
        value={form.username}
        onChangeText={v => { set('username', v); setUsernameError(''); }}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={30}
      />
      {usernameError ? <Text style={styles.errorText}>{usernameError}</Text> : null}
      <Text style={styles.hintText}>@{form.username.toLowerCase() || 'username'} · lowercase letters, numbers, underscores</Text>
      <Text style={styles.dobLabel}>Date of birth</Text>
      <DobPicker
        value={form.dob}
        onChange={v => { set('dob', v); setDobError(''); }}
        error={!!dobError}
      />
      {dobError ? <Text style={[styles.errorText, { marginTop: 6 }]}>{dobError}</Text> : null}
      <Text style={[styles.hintText, { marginTop: 6 }]}>You must be {MIN_AGE}+ to use GoHustlr.</Text>
      <TouchableOpacity
        style={styles.nextBtn}
        disabled={!form.username || !dobComplete}
        onPress={handleUsernameNext}
      >
        <View style={[styles.nextBtnFill, !(form.username && dobComplete) && styles.nextBtnFillDisabled]}>
          <Text
            style={[styles.nextBtnText, !(form.username && dobComplete) && styles.nextBtnTextDisabled]}
            numberOfLines={1}
          >
            Continue
          </Text>
        </View>
      </TouchableOpacity>
    </View>,

    // Step 2 — Role
    <View key="role" style={styles.stepWrap}>
      <Ionicons name="locate" size={56} color={colors.primary} style={styles.emoji} />
      <Text style={styles.stepTitle}>What are you here for?</Text>
      <Text style={styles.stepSub}>You can always change this later in your Profile.</Text>
      {ROLES.map(r => (
        <TouchableOpacity
          key={r.id}
          style={[styles.roleCard, form.role === r.id && styles.roleCardActive]}
          onPress={() => set('role', r.id)}
        >
          <Ionicons name={r.ion} size={24} color={form.role === r.id ? colors.primary : colors.textSecondary} style={styles.roleIcon} />
          <View style={styles.roleInfo}>
            <Text style={[styles.roleLabel, form.role === r.id && styles.roleLabelActive]} numberOfLines={1}>{r.label}</Text>
            <Text style={styles.roleDesc} numberOfLines={2}>{r.desc}</Text>
          </View>
          {form.role === r.id && (
            <Ionicons name="checkmark" size={18} color={colors.primary} style={styles.roleCheck} />
          )}
        </TouchableOpacity>
      ))}
      <TouchableOpacity
        style={styles.nextBtn}
        disabled={!form.role}
        onPress={goNext}
      >
        <View style={[styles.nextBtnFill, !form.role && styles.nextBtnFillDisabled]}>
          <Text style={[styles.nextBtnText, !form.role && styles.nextBtnTextDisabled]} numberOfLines={1}>Continue</Text>
        </View>
      </TouchableOpacity>
    </View>,

    // Step 3 — Location
    <View key="location" style={[styles.stepWrap, { zIndex: 10 }]}>
      <Ionicons name="location" size={56} color={colors.primary} style={styles.emoji} />
      <Text style={styles.stepTitle}>Where are you based?</Text>
      <Text style={styles.stepSub}>Used to surface nearby gigs for you.</Text>
      <View style={{ width: '100%', zIndex: 20 }}>
        <LocationPicker
          value={form.city}
          onChange={v => set('city', v)}
          placeholder="Search any city, or use current location"
        />
      </View>
      <TouchableOpacity
        style={styles.nextBtn}
        disabled={!form.city}
        onPress={goNext}
      >
        <View style={[styles.nextBtnFill, !form.city && styles.nextBtnFillDisabled]}>
          <Text style={[styles.nextBtnText, !form.city && styles.nextBtnTextDisabled]} numberOfLines={1}>Continue</Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity style={styles.skipLink} onPress={goNext}>
        <Text style={styles.skipText} numberOfLines={1}>Skip for now</Text>
      </TouchableOpacity>
    </View>,

    // Step 4 — Skills & Radius (earner/both only) or just finish for posters
    <View key="skills" style={styles.stepWrap}>
      {(form.role === 'earner' || form.role === 'both') ? (
        <>
          <Ionicons name="barbell" size={56} color={colors.primary} style={styles.emoji} />
          <Text style={styles.stepTitle}>Your skills</Text>
          <Text style={styles.stepSub}>Pick what you're great at — earners with skills get hired faster.</Text>
          <View style={styles.skillGrid}>
            {SKILL_OPTIONS.map(s => (
              <TouchableOpacity
                key={s}
                style={[styles.skillChip, form.skills.includes(s) && styles.skillChipActive]}
                onPress={() => toggleSkill(s)}
              >
                <Text style={[styles.skillChipText, form.skills.includes(s) && styles.skillChipTextActive]} numberOfLines={1}>{s}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={[styles.stepSub, { marginTop: 20 }]}>How far are you willing to travel?</Text>
          <View style={styles.radiusRow}>
            {RADIUS_OPTIONS.map(r => (
              <TouchableOpacity
                key={r}
                style={[styles.radiusBtn, form.radiusMiles === r && styles.radiusBtnActive]}
                onPress={() => set('radiusMiles', r)}
              >
                <Text style={[styles.radiusBtnText, form.radiusMiles === r && styles.radiusBtnTextActive]} numberOfLines={1}>
                  {r} mi
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </>
      ) : (
        <>
          <Ionicons name="create" size={56} color={colors.primary} style={styles.emoji} />
          <Text style={styles.stepTitle}>Add a short bio</Text>
          <Text style={styles.stepSub}>Tell earners a bit about yourself and your gigs.</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            placeholder="e.g. College senior looking for reliable help with yard work and errands..."
            placeholderTextColor={colors.textMuted}
            value={form.bio}
            onChangeText={v => set('bio', v)}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            maxLength={280}
          />
        </>
      )}
      <TouchableOpacity style={styles.nextBtn} onPress={goNext}>
        <View style={styles.nextBtnFill}>
          <Text style={styles.nextBtnText} numberOfLines={1}>Almost done</Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity style={styles.skipLink} onPress={goNext}>
        <Text style={styles.skipText} numberOfLines={1}>Skip for now</Text>
      </TouchableOpacity>
    </View>,

    // Step 5 — Done
    <View key="done" style={styles.stepWrap}>
      <Ionicons name="rocket" size={56} color={colors.primary} style={styles.emoji} />
      <Text style={styles.stepTitle}>You're all set!</Text>
      <Text style={styles.stepSub}>
        Welcome to GoHustlr, @{form.username || 'hustler'}.{'\n'}
        Time to start hustling!
      </Text>
      {needsConsent && (
        <View style={styles.acceptRow}>
          <TouchableOpacity
            onPress={() => setAccepted(a => !a)}
            style={[styles.checkbox, accepted && styles.checkboxOn]}
            activeOpacity={0.7}
          >
            {accepted && <Ionicons name="checkmark" size={14} color="#fff" />}
          </TouchableOpacity>
          <Text style={styles.acceptText}>
            I confirm I'm 18 or older and agree to the{' '}
            <Text style={styles.acceptLink} onPress={() => setLegalDoc('terms')}>Terms</Text>,{' '}
            <Text style={styles.acceptLink} onPress={() => setLegalDoc('privacy')}>Privacy Policy</Text>, and{' '}
            <Text style={styles.acceptLink} onPress={() => setLegalDoc('contractor')}>Independent Contractor Agreement</Text>.
          </Text>
        </View>
      )}
      <TouchableOpacity
        style={styles.finishBtnWrap}
        onPress={handleFinish}
        disabled={saving || (needsConsent && !accepted)}
      >
        <View style={[styles.finishBtn, (needsConsent && !accepted) && styles.finishBtnDisabled]}>
          <Text
            style={[styles.finishBtnText, (needsConsent && !accepted) && styles.finishBtnTextDisabled]}
            numberOfLines={1}
          >
            {saving ? 'Setting up...' : 'Enter GoHustlr'}
          </Text>
        </View>
      </TouchableOpacity>
      {finishError ? <Text style={[styles.errorText, { marginTop: 12, textAlign: 'center' }]}>{finishError}</Text> : null}
    </View>,
  ];

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Progress dots */}
      {step > 0 && step < STEPS.length - 1 && (
        <View style={styles.progressRow}>
          {Array.from({ length: STEPS.length - 2 }).map((_, i) => (
            <View
              key={i}
              style={[styles.dot, i < step && styles.dotActive, i === step - 1 && styles.dotCurrent]}
            />
          ))}
        </View>
      )}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Animated.View
          style={[
            styles.slideContainer,
            { transform: [{ translateX: slideAnim }] },
          ]}
        >
          {STEPS.map((s, i) => (
            <View key={i} style={[styles.slide, { left: i * width }]}>
              <ScrollView
                contentContainerStyle={styles.slideScroll}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {s}
              </ScrollView>
            </View>
          ))}
        </Animated.View>
      </KeyboardAvoidingView>

      <Modal visible={!!legalDoc} animationType="slide" onRequestClose={() => setLegalDoc(null)}>
        <View style={[styles.docModal, { paddingTop: insets.top + 8 }]}>
          <View style={styles.docHeader}>
            <Text style={styles.docTitle} numberOfLines={1}>{legalDoc ? (legalDocs[legalDoc]?.title || '') : ''}</Text>
            <TouchableOpacity onPress={() => setLegalDoc(null)} style={styles.docClose}>
              <Ionicons name="close" size={24} color={colors.textPrimary} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 20 }} showsVerticalScrollIndicator={false}>
            <Text style={styles.docBody}>{legalDoc ? (legalDocs[legalDoc]?.body || 'Loading…') : ''}</Text>
            <View style={{ height: 40 }} />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  progressRow: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    paddingVertical: 16,
  },
  dot: {
    width: 8, height: 8, borderRadius: radii.pill,
    backgroundColor: colors.border, marginHorizontal: 4,
  },
  dotActive: { backgroundColor: colors.primary, opacity: 0.4 },
  dotCurrent: { backgroundColor: colors.primary, opacity: 1, width: 20 },
  slideContainer: { flex: 1 },
  slide: { position: 'absolute', width, flex: 1, top: 0, bottom: 0 },
  slideScroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 24 },
  stepWrap: { alignItems: 'center' },
  emoji: { marginBottom: 20 },
  stepTitle: {
    fontSize: 26, fontWeight: '700', color: colors.textPrimary,
    textAlign: 'center', letterSpacing: -0.4, lineHeight: 33, marginBottom: 8,
  },
  stepSub: {
    fontSize: 15, color: colors.textSecondary, textAlign: 'center',
    lineHeight: 22, marginBottom: 28,
  },
  input: {
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, color: colors.textPrimary,
    width: '100%', marginBottom: 4,
  },
  inputError: { borderColor: colors.urgent },
  textArea: { minHeight: 104, lineHeight: 22 },
  errorText: {
    color: colors.urgent, fontSize: 13, fontWeight: '600',
    lineHeight: 18, marginBottom: 8, alignSelf: 'stretch',
  },
  hintText: {
    fontSize: 12, color: colors.textMuted, lineHeight: 16,
    marginBottom: 24, alignSelf: 'stretch',
  },
  dobLabel: {
    fontSize: 13, fontWeight: '600', color: colors.textMuted,
    lineHeight: 18, alignSelf: 'stretch', marginTop: 12, marginBottom: 8,
  },
  nextBtn: { width: '100%', marginTop: 16 },
  nextBtnFill: {
    borderRadius: radii.md, paddingVertical: 16, paddingHorizontal: 20,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  nextBtnFillDisabled: { backgroundColor: colors.border },
  nextBtnText: { color: '#fff', fontSize: 16, fontWeight: '700', lineHeight: 22 },
  nextBtnTextDisabled: { color: colors.textMuted },
  skipLink: { marginTop: 16, paddingVertical: 8, paddingHorizontal: 12 },
  skipText: { fontSize: 14, color: colors.textSecondary, fontWeight: '600', lineHeight: 19 },
  roleCard: {
    width: '100%', flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: colors.border,
  },
  roleCardActive: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  roleIcon: { marginRight: 14 },
  roleInfo: { flex: 1, marginRight: 8 },
  roleLabel: { fontSize: 16, fontWeight: '700', color: colors.textPrimary, lineHeight: 21, marginBottom: 2 },
  roleLabelActive: { color: colors.primary },
  roleDesc: { fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
  roleCheck: { flexShrink: 0 },
  skillGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', width: '100%' },
  skillChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: radii.pill, margin: 4,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  skillChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  skillChipText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, lineHeight: 17 },
  skillChipTextActive: { color: '#fff' },
  radiusRow: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', width: '100%' },
  radiusBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: 18, paddingVertical: 10, borderRadius: radii.pill, margin: 4,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  radiusBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  radiusBtnText: { fontSize: 14, fontWeight: '600', color: colors.textSecondary, lineHeight: 19 },
  radiusBtnTextActive: { color: '#fff' },
  finishBtnWrap: { width: '100%', marginTop: 4 },
  finishBtn: {
    borderRadius: radii.md, paddingVertical: 16, paddingHorizontal: 24,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  finishBtnDisabled: { backgroundColor: colors.border },
  finishBtnText: { color: '#fff', fontSize: 16, fontWeight: '700', lineHeight: 22 },
  finishBtnTextDisabled: { color: colors.textMuted },
  acceptRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 20, width: '100%' },
  checkbox: {
    width: 22, height: 22, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', marginRight: 10, marginTop: 1,
    backgroundColor: colors.surface, flexShrink: 0,
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  acceptText: { flex: 1, flexShrink: 1, fontSize: 13, color: colors.textSecondary, lineHeight: 19, textAlign: 'left' },
  acceptLink: { color: colors.primary, fontWeight: '600' },
  docModal: { flex: 1, backgroundColor: colors.background },
  docHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: colors.divider,
  },
  docTitle: {
    fontSize: 18, fontWeight: '700', color: colors.textPrimary,
    letterSpacing: -0.3, lineHeight: 24, flexShrink: 1, marginRight: 8,
  },
  docClose: { padding: 4, flexShrink: 0 },
  docBody: { fontSize: 14, color: colors.textSecondary, lineHeight: 22 },
});
