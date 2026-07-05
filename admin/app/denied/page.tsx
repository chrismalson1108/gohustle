import { signOutAction } from "../auth-actions";

// Dead end for authenticated accounts that are not in admin_users. Says
// nothing about what exists behind the gate.
export default function DeniedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-[var(--line)] bg-white p-8 text-center shadow-sm">
        <h1 className="mb-2 text-xl font-semibold">Not authorized</h1>
        <p className="mb-6 text-sm text-[var(--muted)]">
          This account doesn&apos;t have access to this tool.
        </p>
        <form action={signOutAction}>
          <button
            type="submit"
            className="w-full rounded-lg border border-[var(--line)] py-2 text-sm font-semibold"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
