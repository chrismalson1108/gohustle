import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { captureError } from '../lib/analytics';
import { colors, radii } from '../theme';

// Catches render-time crashes anywhere below it and shows a recoverable fallback
// instead of a white screen. Reports the error through the analytics layer.
export default class ErrorBoundary extends React.Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    captureError(error, { componentStack: info?.componentStack, boundary: 'root' });
  }

  reset = () => this.setState({ hasError: false });

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.wrap}>
          <Ionicons name="alert-circle-outline" size={56} color={colors.textMuted} style={{ marginBottom: 16 }} />
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.body}>
            The app hit an unexpected error. You can try again — your data is safe.
          </Text>
          <TouchableOpacity style={styles.btn} onPress={this.reset} activeOpacity={0.85}>
            <Text style={styles.btnText} numberOfLines={1}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 20, paddingVertical: 32, backgroundColor: colors.background,
  },
  title: {
    fontSize: 24, fontWeight: '700', color: colors.textPrimary,
    marginBottom: 8, letterSpacing: -0.4, textAlign: 'center',
  },
  body: {
    fontSize: 15, color: colors.textSecondary, textAlign: 'center',
    lineHeight: 22, marginBottom: 24, maxWidth: 360,
  },
  btn: {
    backgroundColor: colors.primary, borderRadius: radii.md,
    paddingVertical: 14, paddingHorizontal: 32, alignSelf: 'center',
  },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
