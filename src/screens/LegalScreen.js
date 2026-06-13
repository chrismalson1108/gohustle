import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { LEGAL_DOCS } from '../data/legal';
import { colors } from '../theme';

// route.params.doc: 'terms' | 'privacy' | 'contractor'
export default function LegalScreen({ route }) {
  const key = route?.params?.doc || 'terms';
  const doc = LEGAL_DOCS[key] || LEGAL_DOCS.terms;
  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>{doc.title}</Text>
        <Text style={styles.body}>{doc.body}</Text>
        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { padding: 20 },
  title: { fontSize: 24, fontWeight: '900', color: colors.textPrimary, marginBottom: 16 },
  body: { fontSize: 14, color: colors.textSecondary, lineHeight: 22 },
});
