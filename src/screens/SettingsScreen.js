import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Switch, ActivityIndicator, KeyboardAvoidingView, Platform, Keyboard,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import { colors, gradients } from '../theme';
import LocationPicker from '../components/LocationPicker';
import { CLASS_STANDINGS, DEGREE_TYPES } from '../lib/school';

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
  const [usernameError, setUsernameError] = useState('');

  const [form, setForm] = useState({
    name: '', username: '', bio: '',
    city: '', role: 'earner', skills: [], radiusMiles: 25, skillRates: {},
    school: '', major: '', degreeType: '', classStanding: '', gradYear: '',
  });

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('name, username, bio, city, role, skills, radius_miles, skill_rates, school, major, degree_type, class_standing, grad_year')
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
        skillRates: data.skill_rates || {},
        school: data.school || '',
        major: data.major || '',
        degreeType: data.degree_type || '',
        classStanding: data.class_standing || '',
        gradYear: data.grad_year ? String(data.grad_year) : '',
      });
    }
    setLoading(false);
  };

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const toggleSkill = (s) => {
    set('skills', form.skills.includes(s)
      ? form.skills.filter(x => x !== s)
      : [...form.skills, s]);
  };

  const setSkillRate = (s, v) => {
    const clean = v.replace(/[^0-9]/g, '');
    setForm(p => ({ ...p, skillRates: { ...p.skillRates, [s]: clean } }));
  };

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
      skill_rates: form.skills.reduce((acc, s) => {
        const r = parseInt(form.skillRates?.[s], 10);
        if (r > 0) acc[s] = r;
        return acc;
      }, {}),
      school: form.school || null,
      major: form.major || null,
      degree_type: form.degreeType || null,
      class_standing: form.classStanding || null,
      grad_year: form.gradYear ? parseInt(form.gradYear, 10) || null : null,
    }).eq('id', user.id);
    setSaving(false);
    if (error) {
      showToast({ icon: '❌', title: 'Save Failed', message: error.message || 'Could not save your profile. Please try again.' });
      return;
    }
    setRole(form.role);
    await refreshProfile();
    showToast({ icon: '✅', title: 'Profile Updated!', message: 'Your settings have been saved.' });
    navigation.goBack();
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
          <Text style={styles.headerTitle}>Profile Settings</Text>
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
                { id: 'earner', ion: 'school',    label: 'Earn' },
                { id: 'poster', ion: 'clipboard', label: 'Post Jobs' },
                { id: 'both',   ion: 'flash',     label: 'Both' },
              ].map(r => (
                <TouchableOpacity
                  key={r.id}
                  style={[styles.roleChip, form.role === r.id && styles.roleChipActive]}
                  onPress={() => { haptic.selection(); set('role', r.id); }}
                >
                  <Ionicons name={r.ion} size={18} color={form.role === r.id ? '#fff' : colors.primary} style={styles.roleChipIcon} />
                  <Text style={[styles.roleChipText, form.role === r.id && styles.roleChipTextActive]}>{r.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </Field>

          <Field label="Location">
            <LocationPicker
              value={form.city}
              onChange={v => set('city', v)}
              placeholder="Your city or 'Remote'"
            />
          </Field>

          <Field label="College (optional)">
            <TextInput
              style={styles.input} placeholder="e.g. University of Texas at Austin"
              placeholderTextColor={colors.textMuted} value={form.school}
              onChangeText={v => set('school', v)}
            />
            <Text style={styles.hintText}>Verify your .edu email on your Profile to earn a Verified Student badge.</Text>
          </Field>

          {!!form.school && (
            <>
              <Field label="Major">
                <TextInput
                  style={styles.input} placeholder="e.g. Computer Science"
                  placeholderTextColor={colors.textMuted} value={form.major}
                  onChangeText={v => set('major', v)}
                />
              </Field>

              <Field label="Class Standing">
                <View style={styles.skillGrid}>
                  {CLASS_STANDINGS.map(s => (
                    <TouchableOpacity
                      key={s}
                      style={[styles.skillChip, form.classStanding === s && styles.skillChipActive]}
                      onPress={() => { haptic.selection(); set('classStanding', form.classStanding === s ? '' : s); }}
                    >
                      <Text style={[styles.skillChipText, form.classStanding === s && styles.skillChipTextActive]}>{s}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </Field>

              <Field label="Degree">
                <View style={styles.skillGrid}>
                  {DEGREE_TYPES.map(d => (
                    <TouchableOpacity
                      key={d}
                      style={[styles.skillChip, form.degreeType === d && styles.skillChipActive]}
                      onPress={() => { haptic.selection(); set('degreeType', form.degreeType === d ? '' : d); }}
                    >
                      <Text style={[styles.skillChipText, form.degreeType === d && styles.skillChipTextActive]}>{d}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </Field>

              <Field label="Graduation Year">
                <TextInput
                  style={styles.input} placeholder="e.g. 2027"
                  placeholderTextColor={colors.textMuted} value={form.gradYear}
                  onChangeText={v => set('gradYear', v.replace(/[^0-9]/g, '').slice(0, 4))}
                  keyboardType="number-pad" maxLength={4}
                />
              </Field>
            </>
          )}

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

              {form.skills.length > 0 && (
                <Field label="Hourly rates (optional)">
                  {form.skills.map(s => (
                    <View key={s} style={styles.rateRow}>
                      <Text style={styles.rateSkill}>{s}</Text>
                      <View style={styles.rateInputWrap}>
                        <Text style={styles.rateDollar}>$</Text>
                        <TextInput
                          style={styles.rateInput}
                          placeholder="—"
                          placeholderTextColor={colors.textMuted}
                          value={form.skillRates?.[s] ? String(form.skillRates[s]) : ''}
                          onChangeText={v => setSkillRate(s, v)}
                          keyboardType="number-pad"
                        />
                        <Text style={styles.rateUnit}>/hr</Text>
                      </View>
                    </View>
                  ))}
                </Field>
              )}
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
  rateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6 },
  rateSkill: { fontSize: 14, color: colors.textPrimary, fontWeight: '600', flex: 1 },
  rateInputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.background, borderRadius: 10, borderWidth: 1.5, borderColor: colors.border, paddingHorizontal: 10, height: 38, width: 110 },
  rateDollar: { fontSize: 14, color: colors.textSecondary, marginRight: 2 },
  rateInput: { flex: 1, fontSize: 14, color: colors.textPrimary, fontWeight: '700' },
  rateUnit: { fontSize: 12, color: colors.textMuted },
  skillChip: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, margin: 4,
    backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.border,
  },
  skillChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  skillChipText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  skillChipTextActive: { color: '#fff' },
  saveBtn: { borderRadius: 16, paddingVertical: 18, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontSize: 17, fontWeight: '800' },
});
