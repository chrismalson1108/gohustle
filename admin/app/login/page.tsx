"use client";

import { useState } from "react";
import { getBrowserSupabase } from "@/lib/supabaseBrowser";
import { loginBlocked, recordLoginAttempt } from "./actions";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Ask the server whether this email/IP is already over the threshold. The throttle
      // and its table existed in SQL with no caller at all, so until now the documented
      // "5 failures per account / 15 min" was not enforced anywhere and the brute-force
      // control had no rows to count.
      if (await loginBlocked(email)) {
        // Same generic string as a bad password: telling an attacker they found a real
        // account and tripped a limit is two facts they did not have.
        setError("Sign-in failed.");
        return;
      }

      const supabase = getBrowserSupabase();
      const { error: err } = await supabase.auth.signInWithPassword({ email, password });

      // Record BEFORE branching, so a failure cannot skip the write that makes the
      // attempt visible to ctl_admin_login_bruteforce.
      //
      // Caught, not awaited bare. The action's own body is already fail-open, but that
      // only covers the RPC — it cannot cover the TRANSPORT. proxy.ts used to answer
      // this POST with a 307 to "/" the moment the session existed, so the call rejected
      // out here, the function unwound past setBusy(false), and the button sat on
      // "Signing in…" forever on every SUCCESSFUL sign-in. The middleware is fixed; this
      // is the belt to that braces. Recording an attempt is detection, never access.
      await recordLoginAttempt(email, !err).catch(() => {});

      if (err) {
        // Deliberately generic — this page is reachable by anyone.
        setError("Sign-in failed.");
        return;
      }

      // A hard navigation, not router.replace(). The session cookie changed one line
      // ago, and this is the boundary where the server must see it: a client-side
      // transition here races the cookie write and the middleware's own redirects, and
      // the router.refresh() that used to follow re-fetched the route being LEFT.
      window.location.assign("/mfa");
    } catch {
      setError("Sign-in failed.");
    } finally {
      // Unconditional. Nothing on this page may leave the button stuck, whatever throws.
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-[var(--line)] bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold">GoHustlr Admin</h1>
        <p className="mb-6 text-sm text-[var(--muted)]">Internal console. Authorized staff only.</p>
        <label className="mb-1 block text-sm font-medium">Email</label>
        <input
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mb-4 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[var(--brand)]"
        />
        <label className="mb-1 block text-sm font-medium">Password</label>
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[var(--brand)]"
        />
        {error && <p className="mb-4 text-sm text-[var(--danger)]">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-[var(--brand)] py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
