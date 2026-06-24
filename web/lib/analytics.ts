// Pluggable analytics + error capture (no-op by default). Mirrors the mobile
// interface (src/lib/analytics.js) so shared call sites behave identically.
const isDev = process.env.NODE_ENV !== "production";

export function identify(_userId: string | null): void {
  /* forward to provider when configured */
}

export function track(event: string, props: Record<string, unknown> = {}): void {
  try {
    if (isDev) console.debug("[track]", event, props);
  } catch {
    /* ignore */
  }
}

export function captureError(error: unknown, context: Record<string, unknown> = {}): void {
  try {
    const message = error instanceof Error ? error.message : String(error);
    if (isDev) console.warn("[error]", message, context);
  } catch {
    /* ignore */
  }
}
