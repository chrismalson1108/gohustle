import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Image,
  StyleSheet, KeyboardAvoidingView, Platform, Alert, Keyboard, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useJobs } from '../context/JobsContext';
import { useUser } from '../context/UserContext';
import { useAuth } from '../context/AuthContext';
import { useHaptic } from '../hooks/useHaptic';
import ScreenHeader from '../components/ScreenHeader';
import LocationPicker from '../components/LocationPicker';
import DateTimePicker from '../components/DateTimePicker';
import TagInput from '../components/TagInput';
import { supabase } from '../lib/supabase';
import { pickImages, uploadImages } from '../lib/uploadImage';
import { findProhibited } from '../lib/contentFilter';
import { moderateText, logModerationBlock } from '../lib/moderation';
import { colors, radii } from '../theme';
import { CATEGORIES } from '../data/mockData';

const CATS = CATEGORIES.filter(c => c.id !== 'all');
const RECURRENCE_OPTS = [
  { id: 'none', label: 'One-time' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'biweekly', label: 'Biweekly' },
  { id: 'monthly', label: 'Monthly' },
];

export default function EditJobScreen({ route, navigation }) {
  const { jobId } = route.params;
  const { jobs, updateJob, deleteJob, posterBookings, clearAmendment } = useJobs();
  const { showToast } = useUser();
  const { user } = useAuth();
  const haptic = useHaptic();

  const job = jobs.find(j => j.id === jobId);
  const isKnownCategory = job ? CATS.some(c => c.id === job.category) : false;

  const [form, setForm] = useState({
    title: job?.title || '',
    category: isKnownCategory ? job.category : 'other',
    customCategory: isKnownCategory ? '' : (job?.category || ''),
    pay: String(job?.pay || ''),
    payType: job?.payType || 'flat',
    location: job?.location || '',
    description: job?.description || '',
    requirements: (job?.requirements || []).join('\n'),
    urgent: job?.urgent || false,
    slots: job?.slots ? job.slots.map(s => ({ ...s })) : [],
    recurrence: job?.recurrence || 'none',
    tags: job?.tags || [],
    hazards: job?.hazards || [],
  });
  const [showCustomCat, setShowCustomCat] = useState(!isKnownCategory && !!job?.category);
  const [photos, setPhotos] = useState(job?.photos || []); // mix of remote URLs + new local URIs
  const [coords, setCoords] = useState(job?.lat != null ? { lat: job.lat, lng: job.lng } : null);
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  // jobs.location is masked server-side (migration 20260722040000); the exact address
  // lives in job_locations (RLS lets the poster read it). Load it into the form so a
  // save doesn't write the masked label back over the real address — only replace the
  // field if the poster hasn't already edited it.
  React.useEffect(() => {
    if (!job?.id) return;
    let active = true;
    supabase.from('job_locations').select('exact_location').eq('job_id', job.id).maybeSingle()
      .then(
        ({ data }) => {
          if (active && data?.exact_location) {
            setForm(p => (p.location === (job.location || '') ? { ...p, location: data.exact_location } : p));
          }
        },
        () => {},  // fetch failed — keep the form's current (masked) value
      );
    return () => { active = false; };
  }, [job?.id]);

  const addPhotos = async () => {
    const res = await pickImages({ multiple: true });
    if (res.canceled) {
      if (res.denied) showToast({ icon: '⚠️', title: 'Photos access needed', message: 'Allow photo access in Settings to add photos.' });
      return;
    }
    setPhotos(prev => [...prev, ...res.uris].slice(0, 6));
  };
  const effectiveCategory = form.category === 'other' ? form.customCategory : form.category;

  // Lock core terms once any booking is confirmed/in-progress
  const jobBookings = posterBookings.filter(b => b.jobId === jobId);
  const lockedBooking = jobBookings.find(b => ['confirmed','completed','verified'].includes(b.status));
  const isLocked = !!lockedBooking;
  const amendmentAccepted = isLocked && lockedBooking.amendmentStatus === 'accepted';
  const canEditCore = !isLocked || amendmentAccepted;
  // Pay is special: once a booking is active there's an escrow hold authorized at
  // the agreed amount, and a Stripe hold cannot be re-priced in place. So pay/payType
  // stay locked even under an accepted amendment — changing them would desync the
  // money from the terms. To change pay, cancel the booking (which releases the hold)
  // and let the earner re-book at the new rate.
  const canEditPay = !isLocked;

  // Hazards are the safety disclosure a worker relied on when booking. Once a booking
  // is locked (and no amendment was accepted) the poster may ADD hazards (more
  // disclosure is always safe) but may not silently REMOVE one. guard_jobs_write
  // enforces the same rule server-side.
  const onHazardsChange = (v) => {
    if (isLocked && !amendmentAccepted) {
      const removed = (form.hazards || []).some(h => !v.includes(h));
      if (removed) {
        haptic.error();
        showToast({ icon: '⚠️', title: 'Safety notes are locked', message: 'A worker already booked — you can add hazards but not remove them.' });
        return;
      }
    }
    set('hazards', v);
  };

  if (!job) {
    return (
      <View style={styles.missingWrap}>
        <Text style={styles.missingText}>
          This gig is no longer available.
        </Text>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.missingBtn}>
          <Text style={styles.missingBtnText} numberOfLines={1}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const handleSave = async () => {
    Keyboard.dismiss();
    if (!form.title || !effectiveCategory || !form.pay || !form.location || !form.description) {
      haptic.error();
      return;
    }
    // Pay must be a real, positive amount — '0'/'-5' pass the truthiness check above
    // but would desync the gig from its escrow hold. Guard before submit. (When pay
    // is locked the field is uneditable, so this only bites a genuine edit.)
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
      showToast({ icon: '⚠️', title: 'Check your wording', message: "This gig contains content that isn't allowed. Please edit it." });
      return;
    }
    // Context-aware check (catches intent a keyword list misses).
    const mod = await moderateText([form.title, form.description].join('\n'), 'gig');
    if (!mod.allowed) {
      haptic.error();
      showToast({ icon: '⚠️', title: 'Check your wording', message: "This gig contains content that isn't allowed. Please edit it." });
      return;
    }
    setSaving(true);
    // Upload any newly added local photos; keep already-hosted URLs in order.
    let finalPhotos = photos;
    try {
      const toUpload = photos.filter(u => !u.startsWith('http'));
      if (toUpload.length) {
        const uploaded = await uploadImages({ uris: toUpload, bucket: 'job-photos', userId: user.id });
        let idx = 0;
        finalPhotos = photos.map(u => (u.startsWith('http') ? u : uploaded[idx++]));
      }
    } catch (e) {
      setSaving(false);
      showToast({ icon: '⚠️', title: 'Photo upload failed', message: e.message || 'Please try again.' });
      return;
    }
    const reqs = form.requirements ? form.requirements.split('\n').filter(Boolean) : [];
    // Gate success on the actual write: updateJob rejects (throws / returns false)
    // when the DB refuses the edit — e.g. guard_jobs_write locking core terms after
    // a booking confirmed between screen load and save. Never claim "Gig Updated!"
    // in that case. (Mirrors PostJobScreen's addJob handling.)
    try {
      const ok = await updateJob(jobId, {
        title: form.title, category: effectiveCategory,
        pay, payType: form.payType,
        location: form.location, description: form.description,
        // Removing every time slot falls back to a bookable "Flexible" slot (same
        // as posting) so an edit can never strand the gig slot-less.
        urgent: form.urgent, requirements: reqs,
        slots: form.slots.length > 0
          ? form.slots
          : [{ id: 's1', label: 'Flexible — Contact to Schedule', taken: false }],
        photos: finalPhotos,
        recurrence: form.recurrence,
        tags: form.tags,
        hazards: form.hazards,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
      });
      if (ok === false) throw new Error('update-rejected');
    } catch (e) {
      setSaving(false);
      haptic.error();
      const msg = e?.message && e.message !== 'update-rejected' ? e.message : 'Please try again.';
      showToast({ icon: '⚠️', title: "Couldn't save changes", message: msg });
      return;
    }
    if (amendmentAccepted && lockedBooking) {
      await clearAmendment(lockedBooking.id);
    }
    setSaving(false);
    haptic.success();
    showToast({ icon: '✏️', title: 'Gig Updated!', message: 'Your changes are live.' });
    navigation.goBack();
  };

  const handleDelete = () => {
    if (isLocked) {
      Alert.alert(
        'Cannot Delete',
        'Someone is actively working this gig. Complete or decline the booking before deleting.',
      );
      return;
    }
    Alert.alert(
      'Delete Gig?',
      `"${job.title}" will be removed and no one can book it.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            haptic.heavy();
            await deleteJob(jobId);
            showToast({ icon: '🗑️', title: 'Gig Deleted', message: 'The listing has been removed.' });
            navigation.goBack();
          },
        },
      ]
    );
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        <ScreenHeader underNav>
          <View style={styles.headerRow}>
            {/* Back is the floating nav button (HERO_OPTS); only Delete lives in the header. */}
            <TouchableOpacity onPress={handleDelete} style={styles.deleteBtn}>
              <Text style={styles.deleteBtnText} numberOfLines={1}>Delete</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.headerTitle} numberOfLines={1}>Edit gig</Text>
          <Text style={styles.headerSub} numberOfLines={2}>{job.title}</Text>
        </ScreenHeader>

        {isLocked && !amendmentAccepted && (
          <View style={styles.lockBanner}>
            <Ionicons name="lock-closed" size={18} color={colors.accentDeep} style={styles.lockIcon} />
            <View style={styles.bannerBody}>
              <Text style={styles.lockTitle} numberOfLines={2}>Core terms locked</Text>
              <Text style={styles.lockDesc}>
                Pay, location, and time slots are locked — an earner has committed to this gig. Use "Request Change" in the Gigs tab to propose an update. Both parties must agree before core terms can change.
              </Text>
            </View>
          </View>
        )}
        {amendmentAccepted && (
          <View style={styles.amendBanner}>
            <Ionicons name="checkmark-circle" size={18} color={colors.success} style={styles.lockIcon} />
            <View style={styles.bannerBody}>
              <Text style={styles.amendTitle} numberOfLines={2}>Amendment accepted</Text>
              <Text style={styles.lockDesc}>
                The earner approved your proposed change. Edit the terms below and save — this unlock is used once. Pay stays locked: it's backed by an escrow hold. To change pay, cancel the booking (releasing the hold) and have the earner re-book.
              </Text>
            </View>
          </View>
        )}

        <View style={styles.form}>
          <Field label="Job title *">
            <TextInput
              style={styles.input} placeholder="e.g. Lawn Mowing, Math Tutor..."
              placeholderTextColor={colors.textMuted} value={form.title}
              onChangeText={v => set('title', v)}
            />
          </Field>

          <Field label="Category *">
            <View style={styles.catGrid}>
              {CATS.map(cat => {
                const active = form.category === cat.id;
                return (
                  <TouchableOpacity key={cat.id}
                    style={[styles.catChip, active && styles.catChipActive]}
                    onPress={() => { haptic.selection(); set('category', cat.id); setShowCustomCat(false); }}
                  >
                    <Ionicons name={cat.ion} size={15} color={active ? '#fff' : colors.textSecondary} style={styles.catChipIcon} />
                    <Text style={[styles.catChipText, active && styles.catChipTextActive]} numberOfLines={1}>{cat.label}</Text>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                style={[styles.catChip, form.category === 'other' && styles.catChipActive]}
                onPress={() => { haptic.selection(); set('category', 'other'); setShowCustomCat(true); }}
              >
                <Ionicons name="create" size={15} color={form.category === 'other' ? '#fff' : colors.textSecondary} style={styles.catChipIcon} />
                <Text style={[styles.catChipText, form.category === 'other' && styles.catChipTextActive]} numberOfLines={1}>Other</Text>
              </TouchableOpacity>
            </View>
            {showCustomCat && (
              <TextInput style={[styles.input, { marginTop: 10 }]} placeholder="Type your category name..."
                placeholderTextColor={colors.textMuted} value={form.customCategory}
                onChangeText={v => set('customCategory', v)} />
            )}
          </Field>

          <Field label="Tags (optional)">
            <TagInput value={form.tags} onChange={v => set('tags', v)} />
          </Field>

          <Field label="Safety notes / hazards (optional)">
            <TagInput value={form.hazards} onChange={onHazardsChange} placeholder="e.g. dog on site, uneven ground, fragile items" />
          </Field>

          <Field label={`Pay *${isLocked && !canEditPay ? '  (locked)' : ''}`}>
            <View style={[styles.payRow, !canEditPay && styles.lockedRow]}>
              <View style={styles.payInputWrap}>
                <Text style={styles.dollar}>$</Text>
                <TextInput
                  style={styles.payInput} placeholder="0" value={form.pay}
                  onChangeText={v => set('pay', v)} keyboardType="numeric"
                  placeholderTextColor={colors.textMuted} editable={canEditPay}
                />
              </View>
              <View style={styles.payTypeGroup}>
                {['flat', 'hourly'].map(t => (
                  <TouchableOpacity key={t}
                    style={[styles.payTypeBtn, form.payType === t && styles.payTypeBtnActive]}
                    onPress={() => { if (!canEditPay) return; haptic.selection(); set('payType', t); }}
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

          <Field label={`Location *${isLocked && !canEditCore ? '  (locked)' : ''}`}>
            {canEditCore
              ? <LocationPicker value={form.location} onChange={(v, c) => { set('location', v); setCoords(c); }} />
              : <View style={[styles.input, styles.lockedInput]}><Text style={styles.lockedValue}>{form.location}</Text></View>
            }
          </Field>

          <Field label="Description *">
            <TextInput style={[styles.input, styles.textArea]} multiline numberOfLines={4}
              textAlignVertical="top" placeholder="Describe the job..."
              placeholderTextColor={colors.textMuted} value={form.description}
              onChangeText={v => set('description', v)} />
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
            <TextInput style={[styles.input, styles.textArea]} multiline numberOfLines={3}
              textAlignVertical="top" placeholder={'e.g. Must have a car\nExperience required'}
              placeholderTextColor={colors.textMuted} value={form.requirements}
              onChangeText={v => set('requirements', v)} />
          </Field>

          <Field label={`Available times${isLocked && !canEditCore ? '  (locked)' : ''}`}>
            {canEditCore
              ? <DateTimePicker slots={form.slots} onChange={slots => set('slots', slots)} />
              : (
                <View style={styles.lockedSlots}>
                  {form.slots.map(s => (
                    <View key={s.id} style={styles.lockedSlotTag}>
                      <Text style={styles.lockedSlotText}>{s.label}</Text>
                    </View>
                  ))}
                </View>
              )
            }
          </Field>

          <Field label="Repeats">
            <View style={styles.catGrid}>
              {RECURRENCE_OPTS.map(opt => {
                const active = form.recurrence === opt.id;
                return (
                  <TouchableOpacity key={opt.id}
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

          <TouchableOpacity onPress={handleSave} activeOpacity={0.85} disabled={saving} style={styles.submitBtn}>
            {saving
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.submitText} numberOfLines={1}>Save changes</Text>}
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
  missingWrap: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    padding: 24, backgroundColor: colors.background,
  },
  missingText: {
    fontSize: 15, color: colors.textSecondary, lineHeight: 21,
    marginBottom: 16, textAlign: 'center',
  },
  missingBtn: {
    paddingVertical: 13, paddingHorizontal: 24,
    borderRadius: radii.md, backgroundColor: colors.primary,
  },
  missingBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  headerRow: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginBottom: 12 },
  deleteBtn: {
    backgroundColor: colors.urgentLight, borderRadius: radii.pill,
    paddingHorizontal: 14, paddingVertical: 7, flexShrink: 0,
  },
  deleteBtnText: { color: colors.urgent, fontSize: 13, fontWeight: '600' },
  headerTitle: {
    fontSize: 26, fontWeight: '700', color: colors.textPrimary,
    letterSpacing: -0.4, lineHeight: 33, marginBottom: 4,
  },
  headerSub: { fontSize: 14, color: colors.textSecondary, lineHeight: 20 },
  lockBanner: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: colors.accentLight,
    marginHorizontal: 20, marginTop: 4,
    borderRadius: radii.lg, padding: 16,
  },
  amendBanner: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: colors.successLight,
    marginHorizontal: 20, marginTop: 4,
    borderRadius: radii.lg, padding: 16,
  },
  bannerBody: { flex: 1, minWidth: 0 },
  lockIcon: { marginRight: 12, marginTop: 1 },
  lockTitle: { fontSize: 14, fontWeight: '700', color: colors.accentDeep, marginBottom: 4, lineHeight: 19 },
  amendTitle: { fontSize: 14, fontWeight: '700', color: colors.success, marginBottom: 4, lineHeight: 19 },
  lockDesc: { fontSize: 13, color: colors.textSecondary, lineHeight: 19 },
  form: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 20 },
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
  // Locked read-only values are dimmed with a divider fill rather than opacity —
  // 0.6-opacity body text on cream drops under 3:1, and the poster still has to
  // read the value they can no longer edit.
  lockedInput: { backgroundColor: colors.divider, borderColor: colors.divider },
  lockedValue: { fontSize: 15, color: colors.textSecondary, lineHeight: 20 },
  lockedRow: { opacity: 0.6 },
  lockedSlots: { marginTop: 4 },
  lockedSlotTag: {
    backgroundColor: colors.divider, borderRadius: radii.md,
    paddingHorizontal: 14, paddingVertical: 10, marginBottom: 8,
    borderWidth: 1, borderColor: colors.divider,
  },
  lockedSlotText: { fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
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
  urgentToggle: {
    borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.md, paddingVertical: 14, paddingHorizontal: 16,
    alignItems: 'center', marginBottom: 20, backgroundColor: colors.surface,
  },
  urgentActive: { backgroundColor: colors.urgentLight, borderColor: colors.urgentLight },
  urgentToggleText: { fontSize: 14, fontWeight: '600', color: colors.textPrimary, textAlign: 'center', lineHeight: 20 },
  urgentToggleTextActive: { color: colors.urgent },
  submitBtn: {
    backgroundColor: colors.primary, borderRadius: radii.md,
    paddingVertical: 16, paddingHorizontal: 20,
    alignItems: 'center', justifyContent: 'center', minHeight: 54,
  },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
