import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Image,
  StyleSheet, KeyboardAvoidingView, Platform, Keyboard, ActivityIndicator,
} from 'react-native';
import { useJobs } from '../context/JobsContext';
import { useUser } from '../context/UserContext';
import { useAuth } from '../context/AuthContext';
import { useHaptic } from '../hooks/useHaptic';
import ScreenHeader from '../components/ScreenHeader';
import LocationPicker from '../components/LocationPicker';
import DateTimePicker from '../components/DateTimePicker';
import TagInput from '../components/TagInput';
import { pickImages, uploadImages } from '../lib/uploadImage';
import { findProhibited } from '../lib/contentFilter';
import { moderateText, logModerationBlock } from '../lib/moderation';
import { notify } from '../lib/push';
import { colors, radii } from '../theme';
import { Ionicons } from '@expo/vector-icons';
import { CATEGORIES } from '../data/mockData';

const CATS = CATEGORIES.filter(c => c.id !== 'all');
const RECURRENCE_OPTS = [
  { id: 'none', label: 'One-time' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'biweekly', label: 'Biweekly' },
  { id: 'monthly', label: 'Monthly' },
];
const INITIAL = {
  title: '', category: '', customCategory: '', pay: '', payType: 'flat',
  location: '', description: '', requirements: '', urgent: false, slots: [],
  recurrence: 'none', tags: [], hazards: [], estHours: '2',
};

// Build initial form state, optionally prefilled from a job being duplicated.
function buildInitial(prefill) {
  if (!prefill) return INITIAL;
  const known = CATS.some(c => c.id === prefill.category);
  return {
    title: prefill.title || '',
    category: known ? prefill.category : 'other',
    customCategory: known ? '' : (prefill.category || ''),
    pay: prefill.pay != null ? String(prefill.pay) : '',
    payType: prefill.payType || 'flat',
    location: prefill.location || '',
    description: prefill.description || '',
    requirements: Array.isArray(prefill.requirements) ? prefill.requirements.join('\n') : '',
    urgent: !!prefill.urgent,
    slots: [],
    recurrence: prefill.recurrence || 'none',
    tags: prefill.tags || [],
    hazards: prefill.hazards || [],
    estHours: prefill.estimatedHours != null ? String(prefill.estimatedHours) : '2',
  };
}

export default function PostJobScreen({ navigation, route }) {
  const { addJob } = useJobs();
  const { showToast, name: myName } = useUser();
  const { user } = useAuth();
  const haptic = useHaptic();
  const prefill = route?.params?.prefill;
  // Rebook flow: set when the poster tapped "Rebook <earner>" on a past booking —
  // after this gig posts, that earner gets a gig-invitation push.
  const rebookEarner = route?.params?.rebookEarner;
  const [form, setForm] = useState(() => buildInitial(prefill));
  const [showCustomCat, setShowCustomCat] = useState(!!prefill && !CATS.some(c => c.id === prefill.category));
  const [photos, setPhotos] = useState([]); // local URIs
  const [coords, setCoords] = useState(prefill?.lat != null ? { lat: prefill.lat, lng: prefill.lng } : null); // { lat, lng } from LocationPicker
  const [posting, setPosting] = useState(false);

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const addPhotos = async () => {
    const res = await pickImages({ multiple: true });
    if (res.canceled) {
      if (res.denied) showToast({ icon: '⚠️', title: 'Photos access needed', message: 'Allow photo access in Settings to add photos.' });
      return;
    }
    setPhotos(prev => [...prev, ...res.uris].slice(0, 6));
  };

  const effectiveCategory = form.category === 'other' ? form.customCategory : form.category;

  const handlePost = async () => {
    Keyboard.dismiss();
    if (!form.title || !effectiveCategory || !form.pay || !form.location || !form.description) {
      haptic.error();
      return;
    }
    // Pay must be a real, positive amount — '0'/'-5' pass the truthiness check above
    // but would post a $0/negative gig that dead-ends at escrow (non-positive
    // PaymentIntent). Guard it before anything else touches the value.
    const pay = parseFloat(form.pay);
    if (!Number.isFinite(pay) || pay <= 0 || pay > 10000) {
      haptic.error();
      showToast({ icon: '⚠️', title: 'Enter a valid pay', message: 'Pay must be more than $0 and no more than $10,000.' });
      return;
    }
    const kwTerm = findProhibited([form.title, form.description, ...(form.tags || []), ...(form.hazards || [])].join(' '));
    if (kwTerm) {
      logModerationBlock(kwTerm, 'gig', `${form.title} ${form.description}`);
      haptic.error();
      showToast({ icon: '⚠️', title: 'Check your wording', message: "Your gig contains content that isn't allowed. Please edit it." });
      return;
    }
    // Context-aware check (catches intent a keyword list misses).
    const mod = await moderateText([form.title, form.description].join('\n'), 'gig');
    if (!mod.allowed) {
      haptic.error();
      showToast({ icon: '⚠️', title: 'Check your wording', message: "Your gig contains content that isn't allowed. Please edit it." });
      return;
    }
    setPosting(true);
    let photoUrls = [];
    try {
      if (photos.length) {
        photoUrls = await uploadImages({ uris: photos, bucket: 'job-photos', userId: user.id });
      }
    } catch (e) {
      setPosting(false);
      showToast({ icon: '⚠️', title: 'Photo upload failed', message: e.message || 'Please try again.' });
      return;
    }
    haptic.success();
    // No times picked → a bookable "Flexible" slot, so the gig is never a
    // slot-less dead end (booking flows around slot selection).
    const slots = form.slots.length > 0
      ? form.slots
      : [{ id: 's1', label: 'Flexible — Contact to Schedule', taken: false }];
    const reqs = form.requirements
      ? form.requirements.split('\n').filter(Boolean)
      : [];
    try {
      await addJob({
        title: form.title,
        category: effectiveCategory,
        pay,
        payType: form.payType,
        location: form.location,
        description: form.description,
        urgent: form.urgent,
        // Hourly gigs multiply pay × hours for the escrow hold (computeEffectivePay),
        // so the poster's estimate must drive it — not a hardcoded 2. Flat gigs
        // ignore this value.
        estimatedHours: form.payType === 'hourly' ? Math.max(1, parseFloat(form.estHours) || 1) : 1,
        requirements: reqs,
        slots,
        photos: photoUrls,
        recurrence: form.recurrence,
        tags: form.tags,
        hazards: form.hazards,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
      });
    } catch (e) {
      // Keep the filled-in form on failure — never a false "Gig Posted!".
      setPosting(false);
      showToast({ icon: '⚠️', title: "Couldn't post your gig", message: e.message || 'Please try again.' });
      return;
    }
    const postedTitle = form.title; // capture before the form resets
    setForm(INITIAL);
    setPhotos([]);
    setCoords(null);
    setShowCustomCat(false);
    setPosting(false);
    if (rebookEarner?.id) {
      // Rebook: invite the previous earner to the fresh gig (same shape as the
      // profile "Invite to a gig" flow — the tap lands them on Browse).
      notify(rebookEarner.id, 'You got a gig invitation',
        `${myName || 'Someone'} invited you to apply to "${postedTitle}"`, { tab: 'HomeTab' });
      showToast({ icon: '🚀', title: 'Gig Posted!', message: `${rebookEarner.name || 'They'} got an invite to apply.` });
    } else {
      showToast({ icon: '🚀', title: 'Gig Posted!', message: 'Your gig is live — students can now apply!' });
    }
    navigation.navigate('GigsMain');
  };

  const incomplete = !form.title || !effectiveCategory || !form.pay || !form.location || !form.description;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingBottom: 60 }}
        keyboardShouldPersistTaps="handled"
      >
        <ScreenHeader underNav>
          <Text style={styles.headerTitle} numberOfLines={2}>
            {rebookEarner ? `Rebook ${rebookEarner.name || ''}`.trim() : prefill ? 'Duplicate gig' : 'Post a gig'}
          </Text>
          <Text style={styles.headerSub} numberOfLines={2}>
            {prefill ? 'Review the details, then post your copy' : 'Hire a motivated college student'}
          </Text>
        </ScreenHeader>

        <View style={styles.form}>
          <Field label="Job title *">
            <TextInput
              style={styles.input}
              placeholder="e.g. Lawn Mowing, Math Tutor..."
              placeholderTextColor={colors.textMuted}
              value={form.title}
              onChangeText={v => set('title', v)}
            />
          </Field>

          <Field label="Category *">
            <View style={styles.catGrid}>
              {CATS.map(cat => {
                const active = form.category === cat.id;
                return (
                  <TouchableOpacity
                    key={cat.id}
                    style={[styles.catChip, active && styles.catChipActive]}
                    onPress={() => {
                      haptic.selection();
                      set('category', cat.id);
                      setShowCustomCat(false);
                    }}
                  >
                    <Ionicons name={cat.ion} size={15} color={active ? '#fff' : colors.textSecondary} style={styles.catChipIcon} />
                    <Text style={[styles.catChipText, active && styles.catChipTextActive]} numberOfLines={1}>{cat.label}</Text>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                style={[styles.catChip, form.category === 'other' && styles.catChipActive]}
                onPress={() => {
                  haptic.selection();
                  set('category', 'other');
                  setShowCustomCat(true);
                }}
              >
                <Ionicons name="create" size={15} color={form.category === 'other' ? '#fff' : colors.textSecondary} style={styles.catChipIcon} />
                <Text style={[styles.catChipText, form.category === 'other' && styles.catChipTextActive]} numberOfLines={1}>Other</Text>
              </TouchableOpacity>
            </View>
            {showCustomCat && (
              <TextInput
                style={[styles.input, { marginTop: 10 }]}
                placeholder="Type your category name..."
                placeholderTextColor={colors.textMuted}
                value={form.customCategory}
                onChangeText={v => set('customCategory', v)}
              />
            )}
          </Field>

          <Field label="Tags (optional)">
            <TagInput value={form.tags} onChange={v => set('tags', v)} />
          </Field>

          <Field label="Safety notes / hazards (optional)">
            <TagInput value={form.hazards} onChange={v => set('hazards', v)} placeholder="e.g. dog on site, uneven ground, fragile items" />
          </Field>

          <Field label="Pay *">
            <View style={styles.payRow}>
              <View style={styles.payInputWrap}>
                <Text style={styles.dollar}>$</Text>
                <TextInput
                  style={styles.payInput}
                  placeholder="0"
                  value={form.pay}
                  onChangeText={v => set('pay', v)}
                  keyboardType="numeric"
                  placeholderTextColor={colors.textMuted}
                />
              </View>
              <View style={styles.payTypeGroup}>
                {['flat', 'hourly'].map(t => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.payTypeBtn, form.payType === t && styles.payTypeBtnActive]}
                    onPress={() => { haptic.selection(); set('payType', t); }}
                  >
                    <Text
                      style={[styles.payTypeBtnText, form.payType === t && styles.payTypeBtnTextActive]}
                      numberOfLines={1}
                    >
                      {t === 'flat' ? 'Flat' : '/hr'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </Field>

          {form.payType === 'hourly' && (
            <Field label="Estimated hours *">
              <TextInput
                style={styles.input}
                placeholder="e.g. 3"
                value={form.estHours}
                onChangeText={v => set('estHours', v)}
                keyboardType="numeric"
                placeholderTextColor={colors.textMuted}
              />
              <Text style={styles.hintText}>
                Used to hold {form.pay ? `~$${((parseFloat(form.pay) || 0) * (parseFloat(form.estHours) || 0)).toFixed(0)}` : 'the estimated total'} on the poster's card. The final charge is based on verified work.
              </Text>
            </Field>
          )}

          <Field label="Location *">
            <LocationPicker
              value={form.location}
              onChange={(v, c) => { set('location', v); setCoords(c); }}
            />
          </Field>

          <Field label="Description *">
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Describe the job in detail..."
              placeholderTextColor={colors.textMuted}
              value={form.description}
              onChangeText={v => set('description', v)}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />
          </Field>

          <Field label="Photos (optional)">
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {photos.map((u, i) => (
                <View key={i} style={styles.thumbWrap}>
                  <Image source={{ uri: u }} style={styles.thumb} />
                  <TouchableOpacity style={styles.thumbRemove} onPress={() => setPhotos(prev => prev.filter((_, idx) => idx !== i))}>
                    <Ionicons name="close" size={13} color="#fff" />
                  </TouchableOpacity>
                </View>
              ))}
              {photos.length < 6 && (
                <TouchableOpacity style={styles.addTile} onPress={addPhotos}>
                  <Ionicons name="camera-outline" size={22} color={colors.textSecondary} />
                  <Text style={styles.addTileText} numberOfLines={1}>Add</Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          </Field>

          <Field label="Requirements (one per line)">
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder={'e.g. Must have a car\nExperience with power tools'}
              placeholderTextColor={colors.textMuted}
              value={form.requirements}
              onChangeText={v => set('requirements', v)}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </Field>

          <Field label="Available times">
            <DateTimePicker
              slots={form.slots}
              onChange={slots => set('slots', slots)}
            />
            {form.slots.length === 0 && (
              <Text style={styles.flexibleHint}>
                No times picked — your gig will show "Flexible — Contact to Schedule".
              </Text>
            )}
          </Field>

          <Field label="Repeats">
            <View style={styles.catGrid}>
              {RECURRENCE_OPTS.map(opt => {
                const active = form.recurrence === opt.id;
                return (
                  <TouchableOpacity
                    key={opt.id}
                    style={[styles.catChip, active && styles.catChipActive]}
                    onPress={() => { haptic.selection(); set('recurrence', opt.id); }}
                  >
                    <Text style={[styles.catChipText, active && styles.catChipTextActive]} numberOfLines={1}>{opt.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </Field>

          <TouchableOpacity
            style={[styles.urgentToggle, form.urgent && styles.urgentActive]}
            onPress={() => { haptic.light(); set('urgent', !form.urgent); }}
          >
            <Text style={[styles.urgentToggleText, form.urgent && styles.urgentToggleTextActive]}>
              {form.urgent ? 'Marked as urgent — needed ASAP' : 'Mark as urgent (optional)'}
            </Text>
          </TouchableOpacity>

          {incomplete && (
            <Text style={styles.validationNote}>* Fill in all required fields to post</Text>
          )}

          <TouchableOpacity
            onPress={handlePost}
            activeOpacity={0.85}
            disabled={posting}
            style={[styles.submitBtn, incomplete && styles.submitBtnDisabled]}
          >
            {posting
              ? <ActivityIndicator color="#fff" />
              : <Text style={[styles.submitText, incomplete && styles.submitTextDisabled]} numberOfLines={1}>Post gig</Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, children }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel} numberOfLines={2}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  headerTitle: {
    fontSize: 26, fontWeight: '700', color: colors.textPrimary,
    letterSpacing: -0.4, lineHeight: 33, marginBottom: 4,
  },
  headerSub: { fontSize: 14, color: colors.textSecondary, lineHeight: 20 },
  form: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20 },
  field: { marginBottom: 24 },
  fieldLabel: {
    fontSize: 13, fontWeight: '600', color: colors.textMuted,
    marginBottom: 8, lineHeight: 18,
  },
  input: {
    backgroundColor: colors.surface, borderRadius: radii.md, padding: 14,
    fontSize: 15, color: colors.textPrimary,
    borderWidth: 1, borderColor: colors.border,
  },
  textArea: { minHeight: 96, lineHeight: 21 },
  thumbWrap: { marginRight: 10 },
  thumb: { width: 84, height: 84, borderRadius: radii.md, backgroundColor: colors.divider },
  thumbRemove: {
    position: 'absolute', top: -6, right: -6,
    width: 22, height: 22, borderRadius: radii.pill, backgroundColor: colors.urgent,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.surface,
  },
  addTile: {
    width: 84, height: 84, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface,
  },
  addTileText: { fontSize: 12, fontWeight: '600', color: colors.textSecondary, marginTop: 4 },
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  catChip: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
    maxWidth: '100%',
    paddingHorizontal: 14, paddingVertical: 9,
    borderRadius: radii.pill, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
  },
  catChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  catChipIcon: { marginRight: 6 },
  catChipText: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, flexShrink: 1 },
  catChipTextActive: { color: '#fff' },
  payRow: { flexDirection: 'row', alignItems: 'center' },
  payInputWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 10,
    flex: 1, minHeight: 50, marginRight: 10,
  },
  dollar: { fontSize: 16, color: colors.textSecondary, marginRight: 4 },
  payInput: { flex: 1, fontSize: 16, color: colors.textPrimary },
  payTypeGroup: {
    flexDirection: 'row', flexShrink: 0,
    backgroundColor: colors.surface, borderRadius: radii.pill,
    borderWidth: 1, borderColor: colors.border, padding: 4,
  },
  payTypeBtn: {
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: radii.pill,
  },
  payTypeBtnActive: { backgroundColor: colors.primary },
  payTypeBtnText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  payTypeBtnTextActive: { color: '#fff' },
  hintText: { fontSize: 12, color: colors.textMuted, marginTop: 8, lineHeight: 18 },
  urgentToggle: {
    borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.md, paddingVertical: 14, paddingHorizontal: 16,
    alignItems: 'center', marginBottom: 20, backgroundColor: colors.surface,
  },
  urgentActive: { backgroundColor: colors.urgentLight, borderColor: colors.urgentLight },
  urgentToggleText: { fontSize: 14, fontWeight: '600', color: colors.textPrimary, textAlign: 'center', lineHeight: 20 },
  urgentToggleTextActive: { color: colors.urgent },
  validationNote: { fontSize: 12, color: colors.textMuted, textAlign: 'center', marginBottom: 12, lineHeight: 17 },
  flexibleHint: { fontSize: 12, color: colors.textMuted, marginTop: 8, lineHeight: 18 },
  submitBtn: {
    backgroundColor: colors.primary, borderRadius: radii.md,
    paddingVertical: 16, paddingHorizontal: 20,
    alignItems: 'center', justifyContent: 'center', minHeight: 54,
  },
  submitBtnDisabled: { backgroundColor: colors.border },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  // textSecondary, not textMuted: on the border-grey fill textMuted lands at
  // ~2:1, which makes the CTA all but vanish exactly when the form is incomplete.
  submitTextDisabled: { color: colors.textSecondary },
});
