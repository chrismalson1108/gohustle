import { Platform } from 'react-native';

let Haptics = null;
if (Platform.OS !== 'web') {
  Haptics = require('expo-haptics');
}

const noop = () => Promise.resolve();

export function useHaptic() {
  if (!Haptics) {
    return { light: noop, medium: noop, heavy: noop, success: noop, error: noop, selection: noop };
  }
  return {
    light:     () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
    medium:    () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
    heavy:     () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy),
    success:   () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    error:     () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
    selection: () => Haptics.selectionAsync(),
  };
}
