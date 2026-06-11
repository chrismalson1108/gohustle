import AsyncStorage from '@react-native-async-storage/async-storage';

const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

export async function cacheSet(key, data) {
  try {
    await AsyncStorage.setItem(`cache:${key}`, JSON.stringify({ data, ts: Date.now() }));
  } catch (_) {}
}

export async function cacheGet(key, maxAge = DEFAULT_TTL) {
  try {
    const raw = await AsyncStorage.getItem(`cache:${key}`);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > maxAge) return null;
    return data;
  } catch (_) {
    return null;
  }
}

export async function cacheRemove(key) {
  try {
    await AsyncStorage.removeItem(`cache:${key}`);
  } catch (_) {}
}

export async function cacheClear(prefix = '') {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const targets = keys.filter(k => k.startsWith(`cache:${prefix}`));
    if (targets.length) await AsyncStorage.multiRemove(targets);
  } catch (_) {}
}
