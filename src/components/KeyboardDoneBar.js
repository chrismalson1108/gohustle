import React from 'react';
import {
  InputAccessoryView, Platform, Pressable, Text, View, Keyboard, StyleSheet,
} from 'react-native';
import { colors } from '../theme';

// A "Done" bar pinned above the iOS keyboard.
//
// WHY THIS EXISTS: some inputs give the user no way to close the keyboard.
//   • multiline inputs have no return key — Return inserts a newline
//   • numeric / decimal-pad keyboards have no return key AT ALL on iOS
// On those, the only escape was tapping some empty area of the screen, which a beta
// tester reported as the keyboard "getting in the way" and refusing to leave.
//
// Android needs no equivalent: the system back gesture dismisses the keyboard, which
// is the platform convention there, and InputAccessoryView is iOS-only. Rendering
// nothing on Android is correct, not a gap.
//
// Usage: render <KeyboardDoneBar /> once inside the screen/modal, and pass
// inputAccessoryViewID={KEYBOARD_DONE_ID} to the inputs that need it.
export const KEYBOARD_DONE_ID = 'hustlrKeyboardDone';

export default function KeyboardDoneBar({ nativeID = KEYBOARD_DONE_ID, label = 'Done' }) {
  if (Platform.OS !== 'ios') return null;
  return (
    <InputAccessoryView nativeID={nativeID}>
      <View style={styles.bar}>
        <Pressable
          onPress={() => Keyboard.dismiss()}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Dismiss keyboard"
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
        >
          <Text style={styles.text} numberOfLines={1}>{label}</Text>
        </Pressable>
      </View>
    </InputAccessoryView>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  btn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  btnPressed: { backgroundColor: colors.background },
  text: { color: colors.primary, fontSize: 16, fontWeight: '600' },
});
