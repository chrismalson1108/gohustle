import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput, Image,
  Modal, KeyboardAvoidingView, Platform, ActivityIndicator, RefreshControl, Share, Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import GradientHeader from '../components/GradientHeader';
import { useUser } from '../context/UserContext';
import { useAuth } from '../context/AuthContext';
import { useHaptic } from '../hooks/useHaptic';
import { pickImage, uploadImage } from '../lib/uploadImage';
import {
  EXPENSE_CATEGORIES, categoryMeta, fetchExpenses, addExpense, deleteExpense, buildCSV,
} from '../lib/expenses';
import { colors, gradients, shadows } from '../theme';

const todayISO = () => new Date().toISOString().slice(0, 10);
const fmt = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function ExpensesScreen({ navigation }) {
  const { earningsTotal } = useUser();
  const { user } = useAuth();
  const haptic = useHaptic();

  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [adding, setAdding] = useState(false);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('supplies');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(todayISO());
  const [receiptUri, setReceiptUri] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    try { setExpenses(await fetchExpenses(user.id)); } catch (_) {}
    setLoading(false);
  }, [user?.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const year = new Date().getFullYear();
  const yearExpenses = expenses.filter(e => (e.date || '').startsWith(String(year)));
  const yearTotal = yearExpenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  const net = Number(earningsTotal || 0) - yearTotal;

  const resetForm = () => {
    setAmount(''); setCategory('supplies'); setDescription(''); setDate(todayISO()); setReceiptUri(null);
  };

  const handlePickReceipt = async () => {
    const picked = await pickImage({});
    if (picked.canceled) return;
    setReceiptUri(picked.uri);
  };

  const handleSave = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { haptic.error(); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { Alert.alert('Invalid date', 'Use the format YYYY-MM-DD.'); return; }
    setSaving(true);
    try {
      let receiptUrl = null;
      if (receiptUri) receiptUrl = await uploadImage({ uri: receiptUri, bucket: 'receipts', userId: user.id });
      const row = await addExpense(user.id, { amount: amt, category, description, date, receiptUrl });
      setExpenses(prev => [row, ...prev].sort((a, b) => (a.date < b.date ? 1 : -1)));
      haptic.success();
      setAdding(false);
      resetForm();
    } catch (e) {
      Alert.alert('Could not save', e.message || 'Please try again.');
    }
    setSaving(false);
  };

  const handleDelete = (exp) => {
    Alert.alert('Delete expense?', `${categoryMeta(exp.category).label} · ${fmt(exp.amount)}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          haptic.medium();
          setExpenses(prev => prev.filter(e => e.id !== exp.id));
          try { await deleteExpense(exp.id); } catch (_) { load(); }
        },
      },
    ]);
  };

  const handleExport = async () => {
    if (!yearExpenses.length) { Alert.alert('Nothing to export', `No expenses recorded for ${year} yet.`); return; }
    const csv = buildCSV(yearExpenses);
    try {
      await Share.share({ title: `GoHustlr expenses ${year}`, message: csv });
    } catch (_) {}
  };

  return (
    <View style={styles.container}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <GradientHeader colors={gradients.profile}>
          <View style={styles.titleRow}>
            <Ionicons name="receipt-outline" size={22} color="#fff" style={{ marginRight: 8 }} />
            <Text style={styles.screenTitle}>Tax Center</Text>
          </View>
          <LinearGradient colors={['rgba(255,255,255,0.18)', 'rgba(255,255,255,0.08)']} style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>{year} deductible expenses</Text>
            <Text style={styles.summaryValue}>{fmt(yearTotal)}</Text>
            <View style={styles.summaryRow}>
              <View style={styles.summaryItem}>
                <Text style={styles.summarySub}>Income (tracked)</Text>
                <Text style={styles.summarySubVal}>{fmt(earningsTotal)}</Text>
              </View>
              <View style={styles.summaryDivider} />
              <View style={styles.summaryItem}>
                <Text style={styles.summarySub}>Net</Text>
                <Text style={[styles.summarySubVal, { color: net >= 0 ? '#A7F3D0' : '#FCA5A5' }]}>{fmt(net)}</Text>
              </View>
            </View>
          </LinearGradient>
        </GradientHeader>

        <View style={styles.actions}>
          <TouchableOpacity style={styles.addBtn} onPress={() => { resetForm(); setAdding(true); }} activeOpacity={0.85}>
            <Ionicons name="add" size={20} color="#fff" style={{ marginRight: 6 }} />
            <Text style={styles.addBtnText}>Add Expense</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.exportBtn} onPress={handleExport} activeOpacity={0.85}>
            <Ionicons name="download-outline" size={18} color={colors.primary} style={{ marginRight: 6 }} />
            <Text style={styles.exportBtnText}>Export CSV</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.disclaimer}>
          Tip: log every cash payment you receive as income and every work-related purchase here. Export the CSV for your accountant or tax software at year end. (Not tax advice.)
        </Text>

        {loading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
        ) : expenses.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="receipt-outline" size={48} color={colors.textMuted} style={{ marginBottom: 12 }} />
            <Text style={styles.emptyTitle}>No expenses yet</Text>
            <Text style={styles.emptyText}>Tap "Add Expense" to start tracking write-offs for tax season.</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {expenses.map(exp => {
              const meta = categoryMeta(exp.category);
              return (
                <View key={exp.id} style={styles.row}>
                  <View style={styles.rowIcon}>
                    <Ionicons name={meta.ion} size={18} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowCat}>{meta.label}</Text>
                    {exp.description ? <Text style={styles.rowDesc} numberOfLines={1}>{exp.description}</Text> : null}
                    <Text style={styles.rowDate}>{exp.date}</Text>
                  </View>
                  {exp.receipt_url ? <Image source={{ uri: exp.receipt_url }} style={styles.rowReceipt} /> : null}
                  <Text style={styles.rowAmount}>{fmt(exp.amount)}</Text>
                  <TouchableOpacity onPress={() => handleDelete(exp)} style={styles.rowDelete}>
                    <Ionicons name="trash-outline" size={16} color={colors.urgent} />
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* Add Expense Modal */}
      <Modal visible={adding} animationType="slide" transparent onRequestClose={() => !saving && setAdding(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => !saving && setAdding(false)} />
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>Add Expense</Text>

              <Text style={styles.label}>Amount</Text>
              <View style={styles.amountRow}>
                <Text style={styles.dollar}>$</Text>
                <TextInput
                  style={styles.amountInput}
                  placeholder="0.00"
                  placeholderTextColor={colors.textMuted}
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="decimal-pad"
                  autoFocus
                />
              </View>

              <Text style={styles.label}>Category</Text>
              <View style={styles.catGrid}>
                {EXPENSE_CATEGORIES.map(c => {
                  const active = category === c.id;
                  return (
                    <TouchableOpacity
                      key={c.id}
                      style={[styles.catChip, active && styles.catChipActive]}
                      onPress={() => { haptic.selection(); setCategory(c.id); }}
                    >
                      <Ionicons name={c.ion} size={14} color={active ? '#fff' : colors.primary} style={{ marginRight: 5 }} />
                      <Text style={[styles.catChipText, active && styles.catChipTextActive]}>{c.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={styles.label}>Date</Text>
              <TextInput
                style={styles.input}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.textMuted}
                value={date}
                onChangeText={setDate}
                autoCapitalize="none"
              />

              <Text style={styles.label}>Note (optional)</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Gas for delivery run"
                placeholderTextColor={colors.textMuted}
                value={description}
                onChangeText={setDescription}
              />

              <Text style={styles.label}>Receipt (optional)</Text>
              {receiptUri ? (
                <View style={styles.receiptPreviewWrap}>
                  <Image source={{ uri: receiptUri }} style={styles.receiptPreview} />
                  <TouchableOpacity style={styles.receiptRemove} onPress={() => setReceiptUri(null)}>
                    <Ionicons name="close" size={14} color="#fff" />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity style={styles.receiptAdd} onPress={handlePickReceipt}>
                  <Ionicons name="camera-outline" size={22} color={colors.primary} />
                  <Text style={styles.receiptAddText}>Attach receipt</Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity onPress={handleSave} disabled={saving} activeOpacity={0.85} style={{ marginTop: 22 }}>
                <LinearGradient colors={gradients.profile} style={styles.saveBtn}>
                  {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Save Expense</Text>}
                </LinearGradient>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => !saving && setAdding(false)} style={styles.cancelBtn}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  titleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  screenTitle: { fontSize: 22, fontWeight: '800', color: '#fff' },
  summaryCard: { borderRadius: 18, padding: 20 },
  summaryLabel: { fontSize: 12, color: 'rgba(255,255,255,0.75)', fontWeight: '600', marginBottom: 4 },
  summaryValue: { fontSize: 34, fontWeight: '900', color: '#fff', marginBottom: 14 },
  summaryRow: { flexDirection: 'row', alignItems: 'center' },
  summaryItem: { flex: 1 },
  summarySub: { fontSize: 11, color: 'rgba(255,255,255,0.7)', fontWeight: '600' },
  summarySubVal: { fontSize: 16, color: '#fff', fontWeight: '800', marginTop: 2 },
  summaryDivider: { width: 1, height: 34, backgroundColor: 'rgba(255,255,255,0.25)', marginHorizontal: 12 },
  actions: { flexDirection: 'row', paddingHorizontal: 16, marginTop: 16, gap: 10 },
  addBtn: {
    flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 13,
  },
  addBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  exportBtn: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: 14, paddingVertical: 13, paddingHorizontal: 16,
    borderWidth: 1.5, borderColor: colors.primary + '40',
  },
  exportBtnText: { color: colors.primary, fontSize: 14, fontWeight: '800' },
  disclaimer: { fontSize: 12, color: colors.textMuted, lineHeight: 18, paddingHorizontal: 16, marginTop: 12 },
  empty: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 50 },
  emptyTitle: { fontSize: 17, fontWeight: '800', color: colors.textPrimary, marginBottom: 8 },
  emptyText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  list: { paddingHorizontal: 16, marginTop: 16 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: 14, padding: 12, marginBottom: 8,
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  rowIcon: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center', marginRight: 12,
  },
  rowCat: { fontSize: 14, fontWeight: '800', color: colors.textPrimary },
  rowDesc: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
  rowDate: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  rowReceipt: { width: 34, height: 34, borderRadius: 8, marginRight: 10, backgroundColor: colors.border },
  rowAmount: { fontSize: 15, fontWeight: '900', color: colors.textPrimary, marginRight: 8 },
  rowDelete: { padding: 4 },
  // modal
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: 24, paddingBottom: 36, maxHeight: '90%', ...shadows.md,
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginTop: 12, marginBottom: 18 },
  modalTitle: { fontSize: 22, fontWeight: '900', color: colors.textPrimary, marginBottom: 16 },
  label: { fontSize: 12, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8, marginTop: 14 },
  amountRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.background,
    borderRadius: 14, borderWidth: 1.5, borderColor: colors.border, paddingHorizontal: 16, height: 56,
  },
  dollar: { fontSize: 24, fontWeight: '800', color: colors.primary, marginRight: 6 },
  amountInput: { flex: 1, fontSize: 26, fontWeight: '800', color: colors.textPrimary },
  input: {
    backgroundColor: colors.background, borderRadius: 14, borderWidth: 1.5, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 13, fontSize: 15, color: colors.textPrimary,
  },
  catGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  catChip: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 20, backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.border,
    marginRight: 8, marginBottom: 8,
  },
  catChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  catChipText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  catChipTextActive: { color: '#fff' },
  receiptPreviewWrap: { alignSelf: 'flex-start' },
  receiptPreview: { width: 100, height: 100, borderRadius: 12, backgroundColor: colors.border },
  receiptRemove: {
    position: 'absolute', top: -6, right: -6, width: 24, height: 24, borderRadius: 12,
    backgroundColor: colors.urgent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff',
  },
  receiptAdd: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderRadius: 14, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.primary,
    backgroundColor: colors.primaryLight, paddingVertical: 14,
  },
  receiptAddText: { fontSize: 14, fontWeight: '700', color: colors.primary, marginLeft: 8 },
  saveBtn: { borderRadius: 16, paddingVertical: 17, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  cancelBtn: { paddingVertical: 14, alignItems: 'center' },
  cancelText: { fontSize: 14, color: colors.textMuted, fontWeight: '600' },
});
