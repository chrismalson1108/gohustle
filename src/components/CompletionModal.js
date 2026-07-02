import React, { useState, useEffect } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, Image,
  ScrollView, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { colors, gradients, shadows } from '../theme';
import { useHaptic } from '../hooks/useHaptic';
import Avatar from './Avatar';

const RATING_LABELS = {
  5: { ion: 'star',           text: 'Excellent' },
  4: { ion: 'happy',          text: 'Great' },
  3: { ion: 'thumbs-up',      text: 'Good' },
  2: { ion: 'remove-circle',  text: 'Fair' },
  1: { ion: 'sad',            text: 'Poor' },
};

function StarPicker({ value, onChange }) {
  const haptic = useHaptic();
  return (
    <View style={styles.starRow}>
      {[1, 2, 3, 4, 5].map(star => (
        <TouchableOpacity
          key={star}
          onPress={() => { haptic.selection(); onChange(star); }}
          style={styles.starBtn}
        >
          <Ionicons
            name={star <= value ? 'star' : 'star-outline'}
            size={34}
            color={star <= value ? '#F59E0B' : colors.border}
          />
        </TouchableOpacity>
      ))}
    </View>
  );
}

export default function CompletionModal({ visible, booking, onClose, onConfirm }) {
  const haptic = useHaptic();
  const [rating, setRating] = useState(5);
  const [reviewText, setReviewText] = useState('');
  const [tipCents, setTipCents] = useState(0);
  const [disputed, setDisputed] = useState(false);
  const [pct, setPct] = useState(0.75);
  const [disputeReason, setDisputeReason] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (visible) {
      setRating(5); setReviewText('');
      setTipCents(0); setDisputed(false); setPct(0.75); setDisputeReason('');
    }
  }, [visible]);

  if (!visible || !booking) return null;

  const earnerName = booking.earner?.name || 'the earner';
  const jobTitle   = booking.job?.title   || 'this job';
  const pay        = booking.job?.pay;
  const payType    = booking.job?.payType;

  // A reduced payout must state a reason (recorded as the dispute audit trail).
  const reasonMissing = disputed && !disputeReason.trim();

  const handleConfirm = async () => {
    if (reasonMissing) { haptic.error(); return; } // guarded by the disabled button too
    haptic.success();
    setLoading(true);
    try {
      await onConfirm({
        rating, reviewText, paymentMethod: 'card', // escrow — funds authorized to the card at accept
        tipCents: tipCents || 0,
        pct: disputed ? pct : 1,
        disputeReason: disputed ? (disputeReason || null) : null,
      });
      onClose();           // only close on success
    } catch (e) {
      // Keep the modal open so the poster can retry; the parent surfaces the error.
      console.warn('Completion confirm failed:', e?.message);
    } finally {
      setLoading(false);   // never strand the spinner
    }
  };

  const TIPS = [0, 300, 500, 1000]; // cents
  // Reduced-payout tiers floored at 50% — the server rejects/relevels anything lower.
  const PCTS = [0.9, 0.75, 0.5];

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.handle} />

          {/* Header */}
          <Text style={styles.heading}>Verify Job Completion</Text>
          <Text style={styles.subheading}>
            Confirm that <Text style={styles.nameHighlight}>{earnerName}</Text> completed "{jobTitle}"
          </Text>

          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {/* Earner avatar */}
            <View style={styles.earnerRow}>
              <Avatar
                url={booking.earner?.avatarUrl}
                initial={booking.earner?.avatarInitial || earnerName[0]}
                size={48}
                fontSize={20}
                style={{ marginRight: 14 }}
              />
              <View>
                <Text style={styles.earnerName}>{earnerName}</Text>
                {pay && (
                  <Text style={styles.earnerJob}>
                    {payType === 'hourly' ? `$${pay}/hr` : `$${pay} flat`} · {jobTitle}
                  </Text>
                )}
              </View>
            </View>

            {/* Escrow confirmation — funds were authorized to the card at accept time */}
            <View style={styles.escrowBox}>
              <Ionicons name="shield-checkmark" size={16} color={colors.success} style={{ marginRight: 8, marginTop: 1 }} />
              <Text style={styles.escrowText}>
                The payment you authorized is held securely on your card. Confirming releases it to {earnerName} (we keep a 10% platform fee) — no new charge.
              </Text>
            </View>

            {/* Before photos submitted by the earner */}
            {booking.beforePhotos?.length > 0 && (
              <>
                <Text style={styles.sectionLabel}>Before</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 20 }}>
                  {booking.beforePhotos.map((u, i) => (
                    <Image key={i} source={{ uri: u }} style={styles.completionPhoto} />
                  ))}
                </ScrollView>
              </>
            )}

            {/* After (completion) photos submitted by the earner */}
            {booking.completionPhotos?.length > 0 && (
              <>
                <Text style={styles.sectionLabel}>After</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 20 }}>
                  {booking.completionPhotos.map((u, i) => (
                    <Image key={i} source={{ uri: u }} style={styles.completionPhoto} />
                  ))}
                </ScrollView>
              </>
            )}

            {/* Star rating */}
            <Text style={styles.sectionLabel}>Rate {earnerName}</Text>
            <StarPicker value={rating} onChange={setRating} />
            <View style={styles.ratingLabelRow}>
              <Ionicons name={RATING_LABELS[rating].ion} size={14} color={colors.textMuted} style={{ marginRight: 5 }} />
              <Text style={styles.ratingLabel}>{RATING_LABELS[rating].text}</Text>
            </View>

            {/* Review text */}
            <Text style={[styles.sectionLabel, { marginTop: 20 }]}>Leave a Review</Text>
            <TextInput
              style={styles.reviewInput}
              placeholder={`How did ${earnerName} do?`}
              placeholderTextColor={colors.textMuted}
              value={reviewText}
              onChangeText={setReviewText}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />

            {/* Tip */}
            <Text style={[styles.sectionLabel, { marginTop: 20 }]}>Add a Tip (optional)</Text>
            <View style={styles.payRow}>
              {TIPS.map(c => (
                <TouchableOpacity
                  key={c}
                  style={[styles.payChip, tipCents === c && styles.payChipActive]}
                  onPress={() => { haptic.selection(); setTipCents(c); }}
                >
                  <Text style={[styles.payLabel, tipCents === c && styles.payLabelActive]}>
                    {c === 0 ? 'No tip' : `$${(c / 100).toFixed(0)}`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            {tipCents > 0 && <Text style={styles.tipNote}>Charged to your saved card and sent to {earnerName}.</Text>}

            {/* Report a problem → partial payment */}
            <TouchableOpacity
              style={[styles.problemToggle, disputed && styles.problemToggleOn]}
              onPress={() => { haptic.selection(); setDisputed(d => !d); }}
            >
              <Ionicons name={disputed ? 'checkbox' : 'square-outline'} size={18} color={disputed ? colors.urgent : colors.textMuted} style={{ marginRight: 8 }} />
              <Text style={styles.problemText}>There was a problem — pay a reduced amount</Text>
            </TouchableOpacity>
            {disputed && (
              <>
                <View style={styles.payRow}>
                  {PCTS.map(p => (
                    <TouchableOpacity
                      key={p}
                      style={[styles.payChip, pct === p && styles.payChipActive]}
                      onPress={() => { haptic.selection(); setPct(p); }}
                    >
                      <Text style={[styles.payLabel, pct === p && styles.payLabelActive]}>Pay {Math.round(p * 100)}%</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TextInput
                  style={styles.reviewInput}
                  placeholder="What went wrong? (shared with support)"
                  placeholderTextColor={colors.textMuted}
                  value={disputeReason}
                  onChangeText={setDisputeReason}
                  multiline
                  numberOfLines={2}
                  textAlignVertical="top"
                />
                <Text style={styles.tipNote}>The rest of the hold is released back to you.</Text>
              </>
            )}

            {/* Confirm button */}
            <TouchableOpacity onPress={handleConfirm} disabled={loading || reasonMissing} activeOpacity={0.85} style={{ marginTop: 24 }}>
              <LinearGradient colors={gradients.earn} style={[styles.confirmBtn, reasonMissing && { opacity: 0.5 }]}>
                {loading
                  ? <ActivityIndicator color="#fff" />
                  : (
                    <View style={styles.confirmRow}>
                      <Ionicons name="checkmark" size={18} color="#fff" style={{ marginRight: 6 }} />
                      <Text style={styles.confirmText}>{reasonMissing ? 'Add a reason to continue' : 'Confirm Job Complete'}</Text>
                    </View>
                  )
                }
              </LinearGradient>
            </TouchableOpacity>

            <TouchableOpacity onPress={onClose} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: 24, paddingBottom: 40, maxHeight: '90%',
    ...shadows.md,
  },
  handle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border,
    alignSelf: 'center', marginTop: 12, marginBottom: 20,
  },
  heading: { fontSize: 22, fontWeight: '900', color: colors.textPrimary, marginBottom: 6 },
  subheading: { fontSize: 14, color: colors.textSecondary, lineHeight: 20, marginBottom: 20 },
  nameHighlight: { fontWeight: '800', color: colors.primary },
  earnerRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.background, borderRadius: 16,
    padding: 14, marginBottom: 24,
  },
  earnerAvatar: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    marginRight: 14,
  },
  earnerInitial: { color: '#fff', fontWeight: '900', fontSize: 20 },
  earnerName: { fontSize: 16, fontWeight: '800', color: colors.textPrimary },
  earnerJob: { fontSize: 12, color: colors.textMuted, marginTop: 3 },
  escrowBox: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: colors.successLight, borderRadius: 14,
    padding: 12, marginBottom: 20,
  },
  escrowText: { flex: 1, fontSize: 12.5, color: colors.textSecondary, lineHeight: 18 },
  sectionLabel: {
    fontSize: 11, fontWeight: '800', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 10,
  },
  completionPhoto: { width: 84, height: 84, borderRadius: 12, marginRight: 8, backgroundColor: colors.border },
  starRow: { flexDirection: 'row', marginBottom: 6 },
  starBtn: { marginRight: 6 },
  star: { fontSize: 34, color: colors.border },
  starFilled: { color: '#F59E0B' },
  ratingLabelRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  ratingLabel: { fontSize: 13, color: colors.textMuted, fontStyle: 'italic' },
  reviewInput: {
    backgroundColor: colors.background, borderRadius: 14,
    borderWidth: 1.5, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 14, color: colors.textPrimary, minHeight: 80,
  },
  payRow: { flexDirection: 'row', flexWrap: 'wrap' },
  payChip: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: 20, borderWidth: 1.5, borderColor: colors.border,
    backgroundColor: colors.surface, paddingHorizontal: 12, paddingVertical: 8,
    marginRight: 8, marginBottom: 8,
  },
  payChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  payIcon: { fontSize: 14, marginRight: 5 },
  payLabel: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  payLabelActive: { color: '#fff' },
  tipNote: { fontSize: 12, color: colors.textMuted, marginTop: 6, lineHeight: 17 },
  problemToggle: { flexDirection: 'row', alignItems: 'center', marginTop: 20, paddingVertical: 4 },
  problemToggleOn: {},
  problemText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, flex: 1 },
  confirmBtn: { borderRadius: 16, paddingVertical: 17, alignItems: 'center' },
  confirmRow: { flexDirection: 'row', alignItems: 'center' },
  confirmText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  cancelBtn: { paddingVertical: 14, alignItems: 'center' },
  cancelText: { fontSize: 14, color: colors.textMuted, fontWeight: '600' },
});
