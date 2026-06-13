// Lightweight analytics + error capture with a pluggable backend.
//
// Today this logs in dev and keeps a small in-memory ring buffer. To enable a
// real provider:
//   • Crash/error monitoring → install @sentry/react-native, set SENTRY_DSN,
//     init it once, and forward in captureError() (Sentry.captureException).
//   • Product analytics → install PostHog/Amplitude, set the key, and forward
//     in track()/identify(). Native SDKs require a dev-client rebuild.
// Until then everything degrades to a safe no-op so the app never breaks.
import { Platform } from 'react-native';

export const SENTRY_DSN = null;      // ← paste your Sentry DSN to enable crash reports
export const ANALYTICS_KEY = null;   // ← paste your PostHog/Amplitude key to enable analytics

let currentUserId = null;
const recent = []; // small ring buffer for debugging
function remember(kind, name, data) {
  recent.push({ t: Date.now(), kind, name, data });
  if (recent.length > 100) recent.shift();
}
export function getRecentEvents() { return [...recent]; }

export function identify(userId) {
  currentUserId = userId || null;
  // TODO: forward to provider (e.g. posthog.identify, Sentry.setUser)
}

export function track(event, props = {}) {
  try {
    remember('event', event, props);
    if (__DEV__) console.log('[track]', event, props);
    // TODO: if (ANALYTICS_KEY) posthog.capture(event, { ...props, userId: currentUserId });
  } catch (_) {}
}

export function captureError(error, context = {}) {
  try {
    const message = error?.message || String(error);
    remember('error', message, context);
    if (__DEV__) console.warn('[error]', message, context, Platform.OS);
    // TODO: if (SENTRY_DSN) Sentry.captureException(error, { extra: { ...context, userId: currentUserId } });
  } catch (_) {}
}
