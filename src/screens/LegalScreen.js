import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { fetchCurrentDocs } from '../lib/legal';
import { colors } from '../theme';

// route.params.doc: 'terms' | 'privacy' | 'contractor'
export default function LegalScreen({ route }) {
  const key = route?.params?.doc || 'terms';
  const [doc, setDoc] = useState(undefined); // undefined=loading, null=not found

  useEffect(() => {
    fetchCurrentDocs()
      .then(map => setDoc(map[key] || null))
      .catch(() => setDoc(null));
  }, [key]);

  if (doc === undefined) {
    return <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>;
  }
  if (!doc) {
    return <View style={styles.center}><Text style={[styles.body, styles.centerText]}>Couldn't load this document. Check your connection and try again.</Text></View>;
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>{doc.title}</Text>
        {/* The AUTHORITATIVE effective date, from the row rather than the prose.
            The body carries its own "Last updated:" line, and that line does not
            survive editing: the current privacy and terms are version 2026-08-06 but
            their prose still reads "July 2, 2026", because the August bodies were
            derived from the July ones and only the changed paragraph was rewritten.
            A legal document that misstates its own date is a bad thing to hand
            someone in a dispute, and prose will drift again. legal_documents.version
            cannot — it is the same value recorded in legal_acceptances, so what is
            shown here is exactly what a user's acceptance points at. */}
        <Text style={styles.version}>
          Version {doc.version}
          {doc.published_at ? ` · in effect since ${new Date(doc.published_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}` : ''}
        </Text>
        <Text style={styles.body}>{doc.body}</Text>
        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20, backgroundColor: colors.background },
  scroll: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 20 },
  title: {
    fontSize: 24, fontWeight: '700', color: colors.textPrimary,
    marginBottom: 16, letterSpacing: -0.4, lineHeight: 30,
  },
  version: {
    fontSize: 12, color: colors.textSecondary, marginBottom: 14,
    marginTop: -8, fontWeight: '600',
  },
  body: { fontSize: 14, color: colors.textSecondary, lineHeight: 22 },
  centerText: { textAlign: 'center' },
});
