// Server-side error sink for edge functions.
//
// WHY THIS EXISTS: the mobile and web clients report failures through
// log-client-error into public.client_errors, which the admin console renders at
// /errors. The edge functions — where every dollar actually moves — reported
// nothing. A failed escrow capture did `console.error(...)` and stopped there
// (stripe-capture-payment), so "the poster pressed pay and it silently didn't
// work" was invisible until someone complained. Supabase function logs exist, but
// nobody watches them, they are not searchable next to the rest of the console,
// and they are not what an operator on support duty has open.
//
// This writes to the SAME table the console already reads, tagged platform='edge'
// with the function name in app_version, so server failures appear in the one
// place the team already looks.
//
// BEST EFFORT, ALWAYS. Never throws, never rejects, never changes the caller's
// control flow — an error sink that can fail a payment is worse than no sink.
//
// It builds its OWN service-role client rather than taking one as an argument:
// every caller is a terminal `catch`, and in each of these functions the
// `const supabase = createClient(...)` lives INSIDE the `try`, so it is not in
// scope where the logging actually needs to happen.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const MAX_MESSAGE = 2000;
const MAX_CONTEXT_BYTES = 8000;

let _sink: SupabaseClient | null = null;
function sinkClient(): SupabaseClient {
  if (!_sink) {
    _sink = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return _sink;
}

/** Reduce an unknown thrown value to a loggable one-line message. */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Record a server-side failure.
 *
 * @param fn       the function name, e.g. 'stripe-capture-payment'
 * @param message  short description; the thrown message is fine
 * @param context  ids and state worth having at 2am — booking_id, payment_intent, status
 * @param opts.fatal  true when a user-visible operation failed outright (money did
 *                    not move when it should have, or moved when it should not).
 *                    /errors can filter on this.
 */
export async function logServerError(
  fn: string,
  message: string,
  context: Record<string, unknown> = {},
  opts: { fatal?: boolean; userId?: string | null } = {},
): Promise<void> {
  try {
    // The context blob is rendered in the admin UI; keep it bounded so a huge
    // Stripe error object can't bloat the table or the page.
    let ctx: Record<string, unknown> = { fn, ...context };
    const serialized = JSON.stringify(ctx);
    if (serialized.length > MAX_CONTEXT_BYTES) {
      ctx = { fn, truncated: true, preview: serialized.slice(0, MAX_CONTEXT_BYTES) };
    }

    await sinkClient().from('client_errors').insert({
      user_id: opts.userId ?? null,
      platform: 'edge',
      app_version: fn,
      message: String(message).slice(0, MAX_MESSAGE),
      context: ctx,
      fatal: opts.fatal ?? false,
    });
  } catch (e) {
    // Truly last resort — the sink itself is down. Keep the original signal in the
    // platform log rather than swallowing it entirely.
    console.error(`logServerError failed (${fn}):`, e, '| original:', message);
  }
}
