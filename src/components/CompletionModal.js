import React, { useState, useEffect } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity,
  ScrollView, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, gradients, shadows } from '../theme';
import { useHaptic } from '../hooks/useHaptic';

const PAYMENT_METHODS = [
  { id: 'cash',   label: 'Cash',    icon: '💵' },
  { id: 'venmo',  label: 'Venmo',   icon: '💙' },
  { id: 'zelle',  label: 'Zelle',   icon: '💜' },
  { id: 'paypal', label: 'PayPal',  icon: '🅿️' },
  { id: 'other',  label: 'Other',   icon: '💳' },
];

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
          <Text style={[styles.star, star <= value && styles.starFilled]}>
            {star <= value ? '⭐' : '☆'}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

export default function CompletionModal({ visible, booking, onClose, onConfirm }) {
  const haptic = useHaptic();
  const [rating, setRating] = useState(5);
  const [reviewText, setReviewText] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (visible) { setRating(5); setReviewText(''); setPaymentMethod('cash'); }
  }, [visible]);

  if (!visible || !booking) return null;

  const earnerName = booking.earner?.name || 'the earner';
  const jobTitle   = booking.job?.title   || 'this job';
  const pay        = booking.job?.pay;
  const payType    = booking.job?.payType;

  const handleConfirm = async () => {
    haptic.success();
    setLoading(true);
    await onConfirm({ rating, reviewText, paymentMethod });
    setLoading(false);
    onClose();
  };

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
              <View style={styles.earnerAvatar}>
                <Text style={styles.earnerInitial}>
                  {booking.earner?.avatarInitial || earnerName[0]?.toUpperCase() || '?'}
                </Text>
              </View>
              <View>
                <Text style={styles.earnerName}>{earnerName}</Text>
                {pay && (
                  <Text style={styles.earnerJob}>
                    {payType === 'hourly' ? `$${pay}/hr` : `$${pay} flat`} · {jobTitle}
                  </Text>
                )}
              </View>
            </View>

            {/* Star rating */}
            <Text style={styles.sectionLabel}>Rate {earnerName}</Text>
            <StarPicker value={rating} onChange={setRating} />
            <Text style={styles.ratingLabel}>
              {rating === 5 ? '⭐ Excellent' : rating === 4 ? '😊 Great' : rating === 3 ? '👍 Good' : rating === 2 ? '😐 Fair' : '😕 Poor'}
            </Text>

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

            {/* Payment method */}
            <Text style={[styles.sectionLabel, { marginTop: 20 }]}>Payment Method</Text>
            <View style={styles.payRow}>
              {PAYMENT_METHODS.map(m => (
                <TouchableOpacity
                  key={m.id}
                  style={[styles.payChip, paymentMethod === m.id && styles.payChipActive]}
                  onPress={() => { haptic.selection(); setPaymentMethod(m.id); }}
                >
                  <Text style={styles.payIcon}>{m.icon}</Text>
                  <Text style={[styles.payLabel, paymentMethod === m.id && styles.payLabelActive]}>
                    {m.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Confirm button */}
            <TouchableOpacity onPress={handleConfirm} disabled={loading} activeOpacity={0.85} style={{ marginTop: 24 }}>
              <LinearGradient colors={gradients.earn} style={styles.confirmBtn}>
                {loading
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.confirmText}>✓ Confirm Job Complete</Text>
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
  sectionLabel: {
    fontSize: 11, fontWeight: '800', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 10,
  },
  starRow: { flexDirection: 'row', marginBottom: 6 },
  starBtn: { marginRight: 6 },
  star: { fontSize: 34, color: colors.border },
  starFilled: { color: '#F59E0B' },
  ratingLabel: { fontSize: 13, color: colors.textMuted, fontStyle: 'italic', marginBottom: 4 },
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
  confirmBtn: { borderRadius: 16, paddingVertical: 17, alignItems: 'center' },
  confirmText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  cancelBtn: { paddingVertical: 14, alignItems: 'center' },
  cancelText: { fontSize: 14, color: colors.textMuted, fontWeight: '600' },
});
