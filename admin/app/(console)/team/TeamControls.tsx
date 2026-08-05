"use client";

import { useState, useTransition } from "react";
import { addTeamMember, setTeamStatus, setTeamRole, type ActionResult } from "./actions";

function Msg({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  return (
    <p className={`mt-2 text-sm ${result.ok ? "text-[var(--muted)]" : "text-[var(--danger)]"}`}>
      {result.message}
    </p>
  );
}

export function AddMemberForm({ isAdmin }: { isAdmin: boolean }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("support");
  const [note, setNote] = useState("");

  if (!isAdmin) return <p className="text-sm text-[var(--muted)]">Adding team members requires the admin role.</p>;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="their GoHustlr account email"
          className="min-w-56 flex-1 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm"
        >
          <option value="support">support</option>
          <option value="admin">admin</option>
        </select>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="note (optional)"
          className="w-40 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm"
        />
        <button
          onClick={() => {
            const fd = new FormData();
            fd.set("email", email);
            fd.set("role", role);
            fd.set("note", note);
            start(async () => {
              const r = await addTeamMember(fd);
              setResult(r);
              if (r.ok) { setEmail(""); setNote(""); }
            });
          }}
          disabled={pending || !email.trim()}
          className="rounded-lg bg-[var(--brand)] px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add"}
        </button>
      </div>
      <Msg result={result} />
    </div>
  );
}

export function MemberControls({
  userId,
  email,
  role,
  status,
  mfaEnrolledAt,
  isSelf,
  isAdmin,
}: {
  userId: string;
  email: string;
  role: string;
  status: string;
  mfaEnrolledAt: string | null;
  isSelf: boolean;
  isAdmin: boolean;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  if (!isAdmin) return <span className="text-xs text-[var(--muted)]">admin only</span>;

  const fire = (action: (fd: FormData) => Promise<ActionResult>, fields: Record<string, string>, confirmMsg?: string) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    const fd = new FormData();
    fd.set("userId", userId);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    start(async () => setResult(await action(fd)));
  };

  const btn = "rounded-lg border border-[var(--line)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface)] disabled:opacity-40";

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {status === "pending" && (
          <button
            className="rounded-lg bg-[var(--brand)] px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-40"
            disabled={pending}
            onClick={() =>
              fire(setTeamStatus, { status: "active" },
                mfaEnrolledAt
                  ? `Activate ${email}?\n\nThey enrolled an authenticator at ${new Date(mfaEnrolledAt).toLocaleString()}.\nConfirm that time with them directly before activating — if it wasn't them, someone else now holds the factor.`
                  : `Activate ${email}?\n\nThey have NOT enrolled an authenticator yet. Activating now re-opens the window this status exists to close. Prefer waiting until they've enrolled.`)
            }
          >
            Activate
          </button>
        )}
        {status === "active" && !isSelf && (
          <button
            className={btn}
            disabled={pending}
            onClick={() => fire(setTeamStatus, { status: "disabled" }, `Revoke console access for ${email}?`)}
          >
            Revoke
          </button>
        )}
        {status === "disabled" && (
          <button className={btn} disabled={pending} onClick={() => fire(setTeamStatus, { status: "active" }, `Restore access for ${email}?`)}>
            Restore
          </button>
        )}
        {!isSelf && (
          <button
            className={btn}
            disabled={pending}
            onClick={() =>
              fire(setTeamRole, { role: role === "admin" ? "support" : "admin" },
                `Change ${email} from ${role} to ${role === "admin" ? "support" : "admin"}?`)
            }
          >
            Make {role === "admin" ? "support" : "admin"}
          </button>
        )}
        {isSelf && <span className="text-xs text-[var(--muted)]">you</span>}
      </div>
      {result && (
        <span className={`max-w-sm text-right text-xs ${result.ok ? "text-[var(--muted)]" : "text-[var(--danger)]"}`}>
          {result.message}
        </span>
      )}
    </div>
  );
}
