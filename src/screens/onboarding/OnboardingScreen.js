import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Dimensions, Animated, Platform, KeyboardAvoidingView, Keyboard,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../context/AuthContext';
import { colors, gradients } from '../../theme';
import LocationPicker from '../../components/LocationPicker';

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
    role: '',
    city: '',
    skills: [],
    radiusMiles: 25,
    bio: '',
  });
  const [usernameError, setUsernameError] = useState('');
  const [saving, setSaving] = useState(false);

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

  const handleUsernameNext = async () => {
    const ok = await checkUsername();
    if (ok) goNext();
  };

  const handleFinish = async () => {
    Keyboard.dismiss();
    setSaving(true);
    await supabase.from('profiles').update({
      username: form.username.trim().toLowerCase(),
      role: form.role,
      city: form.city,
      skills: form.skills,
      radius_miles: form.radiusMiles,
      bio: form.bio || null,
      onboarding_done: true,
    }).eq('id', user.id);
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
        <LinearGradient colors={gradients.primary} style={styles.nextBtnGrad}>
          <Text style={styles.nextBtnText}>Let's Go →</Text>
        </LinearGradient>
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
      <TouchableOpacity
        style={[styles.nextBtn, !form.username && styles.nextBtnDisabled]}
        disabled={!form.username}
        onPress={handleUsernameNext}
      >
        <LinearGradient colors={form.username ? gradients.primary : [colors.border, colors.border]} style={styles.nextBtnGrad}>
          <Text style={styles.nextBtnText}>Continue →</Text>
        </LinearGradient>
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
            <Text style={[styles.roleLabel, form.role === r.id && styles.roleLabelActive]}>{r.label}</Text>
            <Text style={styles.roleDesc}>{r.desc}</Text>
          </View>
          {form.role === r.id && <Text style={styles.roleCheck}>✓</Text>}
        </TouchableOpacity>
      ))}
      <TouchableOpacity
        style={[styles.nextBtn, !form.role && styles.nextBtnDisabled]}
        disabled={!form.role}
        onPress={goNext}
      >
        <LinearGradient colors={form.role ? gradients.primary : [colors.border, colors.border]} style={styles.nextBtnGrad}>
          <Text style={styles.nextBtnText}>Continue →</Text>
        </LinearGradient>
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
        style={[styles.nextBtn, !form.city && styles.nextBtnDisabled]}
        disabled={!form.city}
        onPress={goNext}
      >
        <LinearGradient colors={form.city ? gradients.primary : [colors.border, colors.border]} style={styles.nextBtnGrad}>
          <Text style={styles.nextBtnText}>Continue →</Text>
        </LinearGradient>
      </TouchableOpacity>
      <TouchableOpacity style={styles.skipLink} onPress={goNext}>
        <Text style={styles.skipText}>Skip for now</Text>
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
                <Text style={[styles.skillChipText, form.skills.includes(s) && styles.skillChipTextActive]}>{s}</Text>
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
                <Text style={[styles.radiusBtnText, form.radiusMiles === r && styles.radiusBtnTextActive]}>
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
        <LinearGradient colors={gradients.primary} style={styles.nextBtnGrad}>
          <Text style={styles.nextBtnText}>Almost done →</Text>
        </LinearGradient>
      </TouchableOpacity>
      <TouchableOpacity style={styles.skipLink} onPress={goNext}>
        <Text style={styles.skipText}>Skip for now</Text>
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
      <TouchableOpacity onPress={handleFinish} disabled={saving}>
        <LinearGradient colors={gradients.earn} style={styles.finishBtn}>
          <Text style={styles.finishBtnText}>{saving ? 'Setting up...' : 'Enter GoHustlr'}</Text>
        </LinearGradient>
      </TouchableOpacity>
    </View>,
  ];

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <LinearGradient colors={['#F5F3FF', '#EDE9FE', '#fff']} style={StyleSheet.absoluteFill} />

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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  progressRow: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    paddingVertical: 16,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.border, marginHorizontal: 4 },
  dotActive: { backgroundColor: colors.primary, opacity: 0.5 },
  dotCurrent: { backgroundColor: colors.primary, opacity: 1, width: 20 },
  slideContainer: { flex: 1 },
  slide: { position: 'absolute', width, flex: 1, top: 0, bottom: 0 },
  slideScroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 20 },
  stepWrap: { alignItems: 'center' },
  emoji: { fontSize: 64, marginBottom: 16 },
  stepTitle: { fontSize: 26, fontWeight: '900', color: colors.textPrimary, textAlign: 'center', marginBottom: 10 },
  stepSub: { fontSize: 15, color: colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: 28 },
  input: {
    backgroundColor: '#fff', borderRadius: 16, borderWidth: 1.5, borderColor: colors.border,
    paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, color: colors.textPrimary,
    width: '100%', marginBottom: 4,
  },
  inputError: { borderColor: colors.urgent },
  textArea: { minHeight: 100, lineHeight: 22 },
  errorText: { color: colors.urgent, fontSize: 13, fontWeight: '600', marginBottom: 6, alignSelf: 'flex-start' },
  hintText: { fontSize: 12, color: colors.textMuted, marginBottom: 24, alignSelf: 'flex-start' },
  nextBtn: { width: '100%', marginTop: 12 },
  nextBtnDisabled: { opacity: 0.6 },
  nextBtnGrad: { borderRadius: 16, paddingVertical: 17, alignItems: 'center' },
  nextBtnText: { color: '#fff', fontSize: 17, fontWeight: '800' },
  skipLink: { marginTop: 16 },
  skipText: { fontSize: 14, color: colors.textMuted, fontWeight: '600' },
  roleCard: {
    width: '100%', flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 12,
    borderWidth: 2, borderColor: colors.border,
  },
  roleCardActive: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  roleIcon: { fontSize: 28, marginRight: 14 },
  roleInfo: { flex: 1 },
  roleLabel: { fontSize: 16, fontWeight: '800', color: colors.textPrimary, marginBottom: 2 },
  roleLabelActive: { color: colors.primary },
  roleDesc: { fontSize: 13, color: colors.textMuted, lineHeight: 18 },
  roleCheck: { fontSize: 18, color: colors.primary, fontWeight: '900' },
  skillGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', width: '100%' },
  skillChip: {
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, margin: 4,
    backgroundColor: '#fff', borderWidth: 1.5, borderColor: colors.border,
  },
  skillChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  skillChipText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  skillChipTextActive: { color: '#fff' },
  radiusRow: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', width: '100%' },
  radiusBtn: {
    paddingHorizontal: 18, paddingVertical: 11, borderRadius: 12, margin: 5,
    backgroundColor: '#fff', borderWidth: 1.5, borderColor: colors.border,
  },
  radiusBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  radiusBtnText: { fontSize: 14, fontWeight: '700', color: colors.textSecondary },
  radiusBtnTextActive: { color: '#fff' },
  finishBtn: { borderRadius: 18, paddingVertical: 20, paddingHorizontal: 48, alignItems: 'center', marginTop: 12 },
  finishBtnText: { color: '#fff', fontSize: 18, fontWeight: '900' },
});
