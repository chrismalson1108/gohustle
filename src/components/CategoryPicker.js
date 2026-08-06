import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, SectionList,
  ActivityIndicator, StyleSheet, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, shadows } from '../theme';
import { useHaptic } from '../hooks/useHaptic';
import { ensureCategory, fetchCategories } from '../lib/categories';
import { findProhibited } from '../../shared/contentFilter.js';
import {
  categoriesByGroup,
  categoryIcon,
  categoryLabel,
  resolveCategorySlug,
  searchCategories,
  validateCategoryLabel,
} from '../../shared/categories.js';

// Type-ahead over the whole taxonomy, with the viewer's own recent categories as
// quick chips. This is the control that keeps the vocabulary from fragmenting:
// people mint near-duplicates because retyping is easier than finding what already
// exists, so finding has to be easier than typing. Creating is still possible —
// last, and only when nothing matched.
//
// Mirrors web/components/CategoryPicker.tsx (same props, same behaviour).
//
// Props:
//   value        — one label, or an array of labels when `multiple`
//   onChange(label, slug) — the category the user just acted on:
//                    single   — the new selection; ('', '') when it is cleared
//                    multiple — a TOGGLE: add it when absent from `value`, remove
//                               it when present. Compare with sameCategory(),
//                               never string equality.
//   recentSlugs  — profiles.recent_category_slugs, most recent first
//   multiple, max, allowCreate (default true), disabled, placeholder
export default function CategoryPicker({
  value,
  onChange,
  recentSlugs = [],
  multiple = false,
  max,
  allowCreate = true,
  disabled = false,
  placeholder,
}) {
  const haptic = useHaptic();
  const [index, setIndex] = useState(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // Loaded on mount rather than on open, so the sheet is populated before it
  // animates in. fetchCategories memoizes and shares in-flight reads, so several
  // pickers on one screen cost one round trip.
  const refresh = useCallback(async () => {
    const next = await fetchCategories();
    if (mounted.current) setIndex(next);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const aliases = index ? index.aliases : undefined;

  // Deduped by resolved slug: a profile saved before the taxonomy landed can hold
  // both "Cleaning" and "cleaning" in skills, and rendering both would show two
  // tokens for one category — while removing either removes both, since the parent
  // compares with sameCategory.
  const selected = useMemo(() => {
    const raw = Array.isArray(value) ? value.filter(Boolean) : (value ? [value] : []);
    const seen = new Set();
    return raw.filter((v) => {
      const slug = resolveCategorySlug(v, aliases);
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  }, [value, aliases]);
  const selectedSlugs = useMemo(
    () => new Set(selected.map((v) => resolveCategorySlug(v, aliases))),
    [selected, aliases],
  );
  const atMax = multiple && !!max && selected.length >= max;

  const typed = query.trim();

  const sections = useMemo(() => {
    if (!index) return [];
    const raw = typed
      ? [{ key: 'results', title: null, ion: null, items: searchCategories(typed, { extra: index.list, aliases, limit: 24 }) }]
      : categoriesByGroup(index.list).map((g) => ({ key: g.key, title: g.label, ion: g.ion, items: g.items }));

    // Both shared helpers pool CATEGORY_CATALOG with whatever is passed as `extra`,
    // and our list already contains the catalog — so entries arrive twice. bySlug is
    // also the authority on what is selectable: merged and reserved rows aren't in it.
    const out = [];
    const seen = new Set();
    for (const s of raw) {
      const data = [];
      for (const c of s.items) {
        const hit = index.bySlug[c.slug];
        if (!hit || seen.has(hit.slug)) continue;
        seen.add(hit.slug);
        data.push(hit);
      }
      if (data.length) out.push({ key: s.key, title: s.title, ion: s.ion, data });
    }
    return out;
  }, [index, typed]);

  const recents = useMemo(() => {
    if (!index) return [];
    const out = [];
    const seen = new Set();
    for (const s of recentSlugs || []) {
      const hit = index.bySlug[resolveCategorySlug(s, aliases)];
      if (!hit || seen.has(hit.slug) || selectedSlugs.has(hit.slug)) continue;
      seen.add(hit.slug);
      out.push(hit);
      if (out.length === 6) break;
    }
    return out;
  }, [index, recentSlugs, selectedSlugs, aliases]);

  const typedSlug = typed ? resolveCategorySlug(typed, aliases) : '';
  const matchedExactly = !!typedSlug && !!(index && index.bySlug[typedSlug]);
  const canCreate = allowCreate && !!index && typed.length > 0 && !matchedExactly && !atMax;

  const close = () => {
    setOpen(false);
    setQuery('');
    setError('');
  };

  const pick = (cat) => {
    if (atMax && !selectedSlugs.has(cat.slug)) {
      haptic.error();
      setError(`You can pick up to ${max}.`);
      return;
    }
    haptic.selection();
    setError('');
    setQuery('');
    onChange(cat.label, cat.slug);
    if (!multiple) close();
  };

  const remove = (label, slug) => {
    haptic.light();
    setError('');
    // Single mode has no toggle to report — an empty pair is how it says "cleared".
    if (multiple) onChange(label, slug);
    else onChange('', '');
  };

  const create = async () => {
    if (creating) return;
    const message = validateCategoryLabel(typed, findProhibited);
    if (message) {
      haptic.error();
      setError(message);
      return;
    }
    setCreating(true);
    try {
      const cat = await ensureCategory(typed);
      haptic.selection();
      setQuery('');
      setError('');
      onChange(cat.label, cat.slug);
      if (!multiple) close();
      await refresh();
    } catch (e) {
      haptic.error();
      if (mounted.current) setError(e?.message || "Couldn't add that category.");
    } finally {
      if (mounted.current) setCreating(false);
    }
  };

  const currentLabel = !multiple && value ? categoryLabel(value, index ? index.list : []) : '';
  const fieldPlaceholder = placeholder || (multiple ? 'Add a skill' : 'Choose a category');

  return (
    <View>
      {multiple && selected.length > 0 && (
        <View style={styles.chipsWrap}>
          {selected.map((label) => (
            <TouchableOpacity
              key={label}
              style={styles.selChip}
              onPress={() => remove(label, resolveCategorySlug(label, aliases))}
              disabled={disabled}
              activeOpacity={0.7}
            >
              <Text style={styles.selChipText} numberOfLines={1}>
                {categoryLabel(label, index ? index.list : [])}
              </Text>
              <Ionicons name="close" size={13} color={colors.primary} style={styles.selChipClose} />
            </TouchableOpacity>
          ))}
        </View>
      )}

      <TouchableOpacity
        style={[styles.field, disabled && styles.fieldDisabled]}
        onPress={() => { if (!disabled) { haptic.light(); setOpen(true); } }}
        disabled={disabled}
        activeOpacity={0.7}
      >
        <Ionicons
          name={currentLabel ? categoryIcon(value, index ? index.list : []) : 'grid-outline'}
          size={16}
          color={currentLabel ? colors.textSecondary : colors.textMuted}
          style={styles.fieldIcon}
        />
        <Text style={[styles.fieldText, !currentLabel && styles.fieldPlaceholder]} numberOfLines={1}>
          {currentLabel || fieldPlaceholder}
        </Text>
        {!!currentLabel && !disabled ? (
          <TouchableOpacity
            onPress={() => remove('', '')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="close-circle" size={17} color={colors.textMuted} />
          </TouchableOpacity>
        ) : (
          !disabled && <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
        )}
      </TouchableOpacity>

      <Modal visible={open} animationType="slide" transparent onRequestClose={close}>
        {/* The sheet sits at the bottom, so the keyboard has to push it up — without
            this it stays put and the search field types into a surface the keyboard
            is covering. */}
        <KeyboardAvoidingView
          style={styles.overlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={close} />
          <View style={styles.sheet}>
            <View style={styles.handle} />

            <View style={styles.header}>
              <Text style={styles.title} numberOfLines={1}>
                {multiple ? 'Add skills' : 'Choose a category'}
              </Text>
              <TouchableOpacity onPress={close} style={styles.doneBtn}>
                <Text style={styles.doneText} numberOfLines={1}>{multiple ? 'Done' : 'Close'}</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.searchWrap}>
              <View style={styles.searchRow}>
                <Ionicons name="search" size={16} color={colors.textMuted} style={styles.fieldIcon} />
                <TextInput
                  style={styles.searchInput}
                  value={query}
                  onChangeText={(t) => { setQuery(t); setError(''); }}
                  placeholder="Search categories"
                  placeholderTextColor={colors.textMuted}
                  autoCorrect={false}
                  autoCapitalize="words"
                  returnKeyType="done"
                />
                {query.length > 0 && (
                  <TouchableOpacity
                    onPress={() => { setQuery(''); setError(''); }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="close-circle" size={17} color={colors.textMuted} />
                  </TouchableOpacity>
                )}
              </View>
              {/* Inline, next to the field the text came from: a toast would leave the
                  user staring at a search box with no idea which part was rejected. */}
              {!!error && <Text style={styles.errorText}>{error}</Text>}
            </View>

            <SectionList
              style={styles.list}
              sections={sections}
              keyExtractor={(item) => item.slug}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.listBody}
              showsVerticalScrollIndicator={false}
              initialNumToRender={16}
              ListHeaderComponent={(
                <View>
                  {canCreate && (
                    <TouchableOpacity
                      style={styles.createRow}
                      onPress={create}
                      disabled={creating}
                      activeOpacity={0.7}
                    >
                      {creating
                        ? <ActivityIndicator size="small" color={colors.primary} style={styles.rowIcon} />
                        : <Ionicons name="add-circle-outline" size={18} color={colors.primary} style={styles.rowIcon} />}
                      <Text style={styles.createText} numberOfLines={2}>
                        {creating ? 'Adding…' : `Create “${typed}”`}
                      </Text>
                    </TouchableOpacity>
                  )}
                  {!typed && recents.length > 0 && (
                    <View style={styles.recentsWrap}>
                      <Text style={styles.sectionTitle}>Recent</Text>
                      <View style={styles.recentsRow}>
                        {recents.map((c) => (
                          <TouchableOpacity key={c.slug} style={styles.recentChip} onPress={() => pick(c)}>
                            <Ionicons
                              name={c.ion || 'grid-outline'}
                              size={13}
                              color={colors.textSecondary}
                              style={styles.recentChipIcon}
                            />
                            <Text style={styles.recentChipText} numberOfLines={1}>{c.label}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>
                  )}
                </View>
              )}
              renderSectionHeader={({ section }) => (
                section.title
                  ? (
                    <View style={styles.groupHeader}>
                      <Ionicons name={section.ion || 'grid-outline'} size={13} color={colors.textMuted} style={styles.rowIcon} />
                      <Text style={styles.sectionTitle} numberOfLines={1}>{section.title}</Text>
                    </View>
                  )
                  : null
              )}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.row} onPress={() => pick(item)} activeOpacity={0.7}>
                  <Ionicons name={item.ion || 'grid-outline'} size={17} color={colors.textSecondary} style={styles.rowIcon} />
                  <View style={styles.rowTextWrap}>
                    <Text style={styles.rowText} numberOfLines={1}>{item.label}</Text>
                    {!!typed && !!item.groupLabel && (
                      <Text style={styles.rowSub} numberOfLines={1}>{item.groupLabel}</Text>
                    )}
                  </View>
                  {selectedSlugs.has(item.slug) && <Ionicons name="checkmark" size={18} color={colors.primary} />}
                </TouchableOpacity>
              )}
              ListEmptyComponent={(
                <Text style={styles.emptyText}>
                  {!index
                    ? 'Loading categories…'
                    : (canCreate ? 'Nothing matches — create it above.' : 'No categories match that search.')}
                </Text>
              )}
            />
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  selChip: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.primaryLight,
    borderRadius: radii.pill, paddingHorizontal: 12, paddingVertical: 8,
    alignSelf: 'flex-start', maxWidth: '100%',
  },
  selChipText: { fontSize: 13, fontWeight: '600', color: colors.primary, flexShrink: 1, lineHeight: 17 },
  selChipClose: { marginLeft: 6, flexShrink: 0 },

  field: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 14, minHeight: 50,
  },
  fieldDisabled: { backgroundColor: colors.background },
  fieldIcon: { marginRight: 8, flexShrink: 0 },
  fieldText: { flex: 1, minWidth: 0, fontSize: 15, color: colors.textPrimary, paddingVertical: 12 },
  fieldPlaceholder: { color: colors.textMuted },

  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  // FIXED height, not maxHeight. With maxHeight the sheet was sized by its content,
  // so every keystroke that narrowed the results shrank it — and because it is
  // anchored to the bottom, one or two matches collapsed it to ~250px, entirely
  // behind the keyboard. It read as the whole sheet vanishing: typing "Tr" (24
  // matches) filled the screen, "Tre" (1 match) disappeared, deleting back to "Tr"
  // brought it back. The list scrolls inside a stable surface now.
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    height: '85%', ...shadows.md,
  },
  handle: {
    width: 40, height: 4, borderRadius: radii.pill, backgroundColor: colors.border,
    alignSelf: 'center', marginTop: 12, marginBottom: 8,
  },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 12,
  },
  title: { fontSize: 24, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.4, flexShrink: 1, marginRight: 12 },
  doneBtn: { flexShrink: 0, paddingVertical: 10, paddingLeft: 8 },
  doneText: { fontSize: 14, fontWeight: '600', color: colors.primary },

  searchWrap: { paddingHorizontal: 20, paddingBottom: 4 },
  searchRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 14, minHeight: 48,
  },
  searchInput: { flex: 1, minWidth: 0, fontSize: 15, color: colors.textPrimary, paddingVertical: 12 },
  errorText: { fontSize: 12, color: colors.urgent, marginTop: 6, marginLeft: 4, lineHeight: 16 },

  list: { flex: 1, minHeight: 0 },
  listBody: { paddingHorizontal: 20, paddingBottom: 32, flexGrow: 1 },
  createRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 14, marginTop: 8,
    borderRadius: radii.md, borderWidth: 1, borderColor: colors.primary,
  },
  createText: { fontSize: 14, fontWeight: '600', color: colors.primary, flexShrink: 1, lineHeight: 19 },

  recentsWrap: { marginTop: 16 },
  recentsRow: { flexDirection: 'row', flexWrap: 'wrap' },
  recentChip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: radii.pill,
    marginRight: 8, marginBottom: 8, alignSelf: 'flex-start', maxWidth: '100%',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  recentChipIcon: { marginRight: 6, flexShrink: 0 },
  recentChipText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, flexShrink: 1 },

  groupHeader: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, paddingTop: 20, paddingBottom: 8,
  },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: colors.textMuted, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13 },
  rowIcon: { marginRight: 10, flexShrink: 0 },
  rowTextWrap: { flex: 1, minWidth: 0, marginRight: 10 },
  rowText: { fontSize: 15, color: colors.textPrimary, fontWeight: '500', lineHeight: 20 },
  rowSub: { fontSize: 12, color: colors.textMuted, marginTop: 2, lineHeight: 16 },
  emptyText: { fontSize: 13, color: colors.textMuted, paddingVertical: 24, lineHeight: 18 },
});
