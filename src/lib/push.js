// Expo push notifications: device registration + a notify() helper that calls
// the send-push edge function. Everything is guarded so web / simulators / the
// missing native module never throw — failures degrade to no-ops.
import { Platform } from 'react-native';
import { supabase } from './supabase';

let Notifications = null;
let Device = null;
let Constants = null;
if (Platform.OS !== 'web') {
  try {
    Notifications = require('expo-notifications');
    Device = require('expo-device');
    Constants = require('expo-constants').default;
  } catch {
    Notifications = null;
  }
}

// Foreground notifications should still surface a banner.
if (Notifications) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

let lastToken = null; // remember this device's token for sign-out cleanup

function projectId() {
  return (
    Constants?.expoConfig?.extra?.eas?.projectId ??
    Constants?.easConfig?.projectId ??
    undefined
  );
}

// Request permission, get the Expo push token, and upsert it for this user.
// Returns the token string, or null when unavailable (web, simulator, denied).
export async function registerPushToken(userId) {
  if (!Notifications || !userId) return null;
  try {
    if (Device && !Device.isDevice) return null; // no push on simulators

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.MAX,
      });
    }

    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;
    if (existing !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      status = req.status;
    }
    if (status !== 'granted') return null;

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId: projectId() });
    const token = tokenData?.data;
    if (!token) return null;

    lastToken = token;
    await supabase.from('push_tokens').upsert(
      { user_id: userId, token, platform: Platform.OS, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,token' }
    );
    return token;
  } catch (e) {
    console.warn('registerPushToken:', e?.message || e);
    return null;
  }
}

// Remove this device's token on sign-out so a signed-out phone stops receiving.
export async function unregisterPushToken(userId) {
  if (!userId || !lastToken) return;
  try {
    await supabase.from('push_tokens').delete().eq('user_id', userId).eq('token', lastToken);
  } catch (e) {
    console.warn('unregisterPushToken:', e?.message || e);
  }
  lastToken = null;
}

// Add a tap-handler that routes via the provided callback ({ data }) => void.
// Returns an unsubscribe function.
export function addNotificationResponseListener(handler) {
  if (!Notifications) return () => {};
  const sub = Notifications.addNotificationResponseReceivedListener(response => {
    handler?.(response?.notification?.request?.content?.data || {});
  });
  return () => sub.remove();
}

const FUNCTIONS_URL = 'https://nfioebqsgmmzhbksxozc.supabase.co/functions/v1';
const SUPABASE_ANON_KEY = 'sb_publishable_1jX6yS1Wlx6_SxJ_07TnIw_VsYEE_Pu';

// Fire a push to another user. Best-effort: never throws into UI flows.
export async function notify(userId, title, body, data = {}) {
  if (!userId || !title) return;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    await fetch(`${FUNCTIONS_URL}/send-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ userId, title, body, data }),
    });
  } catch (e) {
    console.warn('notify:', e?.message || e);
  }
}
