// Web notifications layer. The web app can't register Expo push tokens, but the
// cross-platform `notify()` (server-side fan-out to a recipient's *mobile* push
// tokens via the send-push edge function) is still useful — a poster on the web
// can ping an earner's phone. Local reminders are native-only no-ops here.
import { callEdgeFunction } from "./edge";

// Fire a push to another user's devices. Best-effort: never throws into UI flows.
export async function notify(
  userId: string,
  title: string,
  body: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  if (!userId || !title) return;
  try {
    await callEdgeFunction("send-push", { userId, title, body, data });
  } catch {
    // ignore — notifications are best-effort
  }
}

// Native-only on mobile; harmless no-ops on web so shared call sites stay simple.
export async function scheduleGigReminder(): Promise<void> {}
export async function cancelGigReminder(): Promise<void> {}
export async function registerPushToken(): Promise<null> {
  return null;
}
export async function unregisterPushToken(): Promise<void> {}
