// Pluggable analytics + error capture (no-op by default). Mirrors the mobile
// interface (src/lib/analytics.js) so shared call sites behave identically.
const isDev = process.env.NODE_ENV !== "production";

export function identify(userId: string | null): void {
  void userId; /* forward to provider when configured */
}

export function track(event: string, props: Record<string, unknown> = {}): void {
  try {
    if (isDev) console.debug("[track]", event, props);
  } catch {
    /* ignore */
  }
}

export function captureError(
  error: unknown,
  context: Record<string, unknown> = {},
  { fatal = false }: { fatal?: boolean } = {},
): void {
  try {
    const message = error instanceof Error ? error.message : String(error);
    if (isDev) console.warn("[error]", message, context);
    // Forward to the server-side sink (client_errors -> admin console) so a
    // production error is observable at all. Mirrors src/lib/analytics.js.
    //
    // Deliberately not awaited and never throws: the caller is already handling a
    // failure, so telemetry must not add latency or a second error. Signed-out
    // callers are dropped by the function (401), which is fine.
    reportError(message, context, fatal);
  } catch {
    /* ignore */
  }
}

// Fire-and-forget POST to the log-client-error edge function. Imported lazily so this
// module has no import cycle with the Supabase client.
function reportError(message: string, context: Record<string, unknown>, fatal: boolean): void {
  try {
    void import("./supabaseClient")
      .then(({ supabase }) =>
        supabase.functions.invoke("log-client-error", {
          // See src/lib/analytics.js — keeps `next dev` crashes out of the
          // production error queue the admin console triages.
          body: {
            message, context, platform: "web", appVersion: null, fatal,
            dev: process.env.NODE_ENV !== "production",
          },
        }),
      )
      .catch(() => {});
  } catch {
    /* never let telemetry break the caller */
  }
}
