import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Switch, ActivityIndicator, KeyboardAvoidingView, Platform, Keyboard,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import { colors, gradients } from '../theme';

const US_CITIES = [
  'Remote / Online', 'New York, NY', 'Los Angeles, CA', 'Chicago, IL',
  'Houston, TX', 'Phoenix, AZ', 'Philadelphia, PA', 'San Antonio, TX',
  'San Diego, CA', 'Dallas, TX', 'San Jose, CA', 'Austin, TX',
  'Jacksonville, FL', 'Fort Worth, TX', 'Columbus, OH', 'Charlotte, NC',
  'Indianapolis, IN', 'San Francisco, CA', 'Seattle, WA', 'Denver, CO',
  'Nashville, TN', 'Oklahoma City, OK', 'Portland, OR', 'Las Vegas, NV',
  'Memphis, TN', 'Louisville, KY', 'Baltimore, MD', 'Milwaukee, WI',
  'Atlanta, GA', 'Miami, FL', 'Boston, MA', 'Minneapolis, MN',
  'Pittsburgh, PA', 'Raleigh, NC', 'St. Louis, MO', 'Tampa, FL', 'Orlando, FL',
];

const SKILL_OPTIONS = [
  'Lawn Care', 'Moving Help', 'Cleaning', 'Tutoring', 'Tech Help',
  'Delivery', 'Pet Care', 'Handyman', 'Photography', 'Writing',
  'Design', 'Cooking', 'Driving', 'Assembly', 'Painting',
  'Music', 'Fitness', 'Childcare', 'Errands', 'Other',
];

const RADIUS_OPTIONS = [5, 10, 15, 25, 50];

export default function SettingsScreen({ navigation }) {
  const { user } = useAuth();
  const { showToast, setRole, refreshProfile } = useUser();
  const haptic = useHaptic();
  const insets = useSafeAreaInsets();

  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [citySearch, setCitySearch] = useState('');
  const [showCities, setShowCities] = useState(false);
  const [usernameError, setUsernameError] = useState('');

  const [form, setForm] = useState({
    name: '', username: '', bio: '',
    city: '', role: 'earner', skills: [], radiusMiles: 25,
  });

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('name, username, bio, city, role, skills, radius_miles')
      .eq('id', user.id)
      .single();
    if (data) {
      setForm({
        name: data.name || '',
        username: data.username || '',
        bio: data.bio || '',
        city: data.city || '',
        role: data.role || 'earner',
        skills: data.skills || [],
        radiusMiles: data.radius_miles || 25,
      });
      setCitySearch(data.city || '');
    }
    setLoading(false);
  };

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const toggleSkill = (s) => {
    set('skills', form.skills.includes(s)
      ? form.skills.filter(x => x !== s)
      : [...form.skills, s]);
  };

  const filteredCities = citySearch.length > 0
    ? US_CITIES.filter(c => c.toLowerCase().includes(citySearch.toLowerCase())).slice(0, 6)
    : [];

  const checkUsername = async () => {
    const u = form.username.trim().toLowerCase();
    if (!u) return true;
    if (!/^[a-z0-9_]{3,30}$/.test(u)) {
      setUsernameError('3–30 chars, lowercase letters/numbers/underscores only');
      return false;
    }
    const { data } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', u)
      .neq('id', user.id)
      .maybeSingle();
    if (data) { setUsernameError('That username is already taken'); return false; }
    setUsernameError('');
    return true;
  };

  const handleSave = async () => {
    Keyboard.dismiss();
    const ok = await checkUsername();
    if (!ok) return;
    setSaving(true);
    haptic.success();
    const avatarInitial = form.name?.trim().charAt(0).toUpperCase() || 'H';
    const { error } = await supabase.from('profiles').update({
      name: form.name,
      avatar_initial: avatarInitial,
      username: form.username.trim().toLowerCase() || null,
      bio: form.bio || null,
      city: form.city || null,
      role: form.role,
      skills: form.skills,
      radius_miles: form.radiusMiles,
    }).eq('id', user.id);
    setSaving(false);
    if (!error) {
      setRole(form.role);
      await refreshProfile();
      showToast({ icon: '✅', title: 'Profile Updated!', message: 'Your settings have been saved.' });
      navigation.goBack();
    }
  };

  if (loading) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        <LinearGradient colors={gradients.profile} style={[styles.header, { paddingTop: insets.top + 16 }]}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
              <Text style={styles.backText}>‹ Back</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.headerTitle}>Profile Settings ⚙️</Text>
          <Text style={styles.headerSub}>Change your info, role, location, and skills</Text>
        </LinearGradient>

        <View style={styles.form}>
          <Field label="Display Name">
            <TextInput
              style={styles.input} placeholder="Your name"
              placeholderTextColor={colors.textMuted} value={form.name}
              onChangeText={v => set('name', v)} autoCapitalize="words"
            />
          </Field>

          <Field label="Username">
            <TextInput
              style={[styles.input, usernameError && styles.inputError]}
              placeholder="e.g. chris_hustler" placeholderTextColor={colors.textMuted}
              value={form.username} onChangeText={v => { set('username', v); setUsernameError(''); }}
              autoCapitalize="none" autoCorrect={false} maxLength={30}
            />
            {usernameError ? <Text style={styles.errorText}>{usernameError}</Text> : null}
            <Text style={styles.hintText}>@{form.username || 'username'} · 3–30 lowercase chars</Text>
          </Field>

          <Field label="Bio">
            <TextInput
              style={[styles.input, styles.textArea]} multiline numberOfLines={3}
              textAlignVertical="top" placeholder="A short bio about yourself..."
              placeholderTextColor={colors.textMuted} value={form.bio}
              onChangeText={v => set('bio', v)} maxLength={280}
            />
          </Field>

          <Field label="I'm here to...">
            <View style={styles.roleRow}>
              {[
                { id: 'earner', icon: '🎓', label: 'Earn' },
                { id: 'poster', icon: '📋', label: 'Post Jobs' },
                { id: 'both',   icon: '⚡', label: 'Both' },
              ].map(r => (
                <TouchableOpacity
                  key={r.id}
                  style={[styles.roleChip, form.role === r.id && styles.roleChipActive]}
                  onPress={() => { haptic.selection(); set('role', r.id); }}
                >
                  <Text style={styles.roleChipIcon}>{r.icon}</Text>
                  <Text style={[styles.roleChipText, form.role === r.id && styles.roleChipTextActive]}>{r.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </Field>

          <Field label="Location">
            <View style={{ position: 'relative', zIndex: 20 }}>
              <TextInput
                style={styles.input} placeholder="Search your city..."
                placeholderTextColor={colors.textMuted}
                value={citySearch} onFocus={() => setShowCities(true)}
                onChangeText={v => { setCitySearch(v); set('city', v); setShowCities(true); }}
              />
              {showCities && filteredCities.length > 0 && (
                <View style={styles.dropdown}>
                  {filteredCities.map(c => (
                    <TouchableOpacity
                      key={c} style={styles.dropdownItem}
                      onPress={() => { set('city', c); setCitySearch(c); setShowCities(false); }}
                    >
                      <Text style={styles.dropdownText}>{c}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>
          </Field>

          {(form.role === 'earner' || form.role === 'both') && (
            <>
              <Field label="Travel Radius">
                <View style={styles.radiusRow}>
                  {RADIUS_OPTIONS.map(r => (
                    <TouchableOpacity
                      key={r}
                      style={[styles.radiusBtn, form.radiusMiles === r && styles.radiusBtnActive]}
                      onPress={() => { haptic.selection(); set('radiusMiles', r); }}
                    >
                      <Text style={[styles.radiusBtnText, form.radiusMiles === r && styles.radiusBtnTextActive]}>
                        {r} mi
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </Field>

              <Field label="My Skills">
                <View style={styles.skillGrid}>
                  {SKILL_OPTIONS.map(s => (
                    <TouchableOpacity
                      key={s}
                      style={[styles.skillChip, form.skills.includes(s) && styles.skillChipActive]}
                      onPress={() => { haptic.selection(); toggleSkill(s); }}
                    >
                      <Text style={[styles.skillChipText, form.skills.includes(s) && styles.skillChipTextActive]}>{s}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </Field>
            </>
          )}

          <TouchableOpacity onPress={handleSave} disabled={saving} activeOpacity={0.85}>
            <LinearGradient colors={gradients.profile} style={styles.saveBtn}>
              {saving
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.saveBtnText}>Save Changes ✓</Text>
              }
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, children }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background },
  container: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: 20, paddingBottom: 24 },
  headerRow: { marginBottom: 12 },
  backBtn: { padding: 4 },
  backText: { color: 'rgba(255,255,255,0.85)', fontSize: 16, fontWeight: '700' },
  headerTitle: { fontSize: 24, fontWeight: '900', color: '#fff', marginBottom: 4 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.7)' },
  form: { padding: 20 },
  field: { marginBottom: 22 },
  fieldLabel: {
    fontSize: 12, fontWeight: '800', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8,
  },
  input: {
    backgroundColor: colors.surface, borderRadius: 14, padding: 14,
    fontSize: 15, color: colors.textPrimary, borderWidth: 1.5, borderColor: colors.border,
  },
  inputError: { borderColor: colors.urgent },
  textArea: { minHeight: 80, lineHeight: 22 },
  errorText: { color: colors.urgent, fontSize: 12, fontWeight: '600', marginTop: 4 },
  hintText: { fontSize: 12, color: colors.textMuted, marginTop: 4 },
  roleRow: { flexDirection: 'row' },
  roleChip: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 12, borderRadius: 14, marginRight: 8,
    backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.border,
  },
  roleChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  roleChipIcon: { fontSize: 16, marginRight: 5 },
  roleChipText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  roleChipTextActive: { color: '#fff' },
  radiusRow: { flexDirection: 'row', flexWrap: 'wrap' },
  radiusBtn: {
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, margin: 4,
    backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.border,
  },
  radiusBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  radiusBtnText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  radiusBtnTextActive: { color: '#fff' },
  skillGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  skillChip: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, margin: 4,
    backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.border,
  },
  skillChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  skillChipText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  skillChipTextActive: { color: '#fff' },
  dropdown: {
    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
    backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: colors.border,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 8,
    elevation: 8,
  },
  dropdownItem: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  dropdownText: { fontSize: 14, color: colors.textPrimary },
  saveBtn: { borderRadius: 16, paddingVertical: 18, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontSize: 17, fontWeight: '800' },
});
