"use client";

import { useState, useTransition } from "react";
import {
  suspendUser,
  unsuspendUser,
  forceSignOut,
  setVerified,
  resetProfileFields,
  sendPasswordReset,
  deleteAccount,
  confirmEmail,
  changeEmail,
  grantStudent,
  type ActionResult,
} from "./actions";

// Buttons are hidden for the support role, but that's cosmetic — every server
// action re-checks requireAdmin('admin') on its own.
export default function ActionsPanel({
  userId,
  email,
  suspended,
  verified,
  emailConfirmed,
  student,
  isAdmin,
}: {
  userId: string;
  email: string | null;
  suspended: boolean;
  verified: boolean;
  emailConfirmed: boolean;
  student: boolean;
  isAdmin: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [suspendReason, setSuspendReason] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [newEmail, setNewEmail] = useState("");

  if (!isAdmin) {
    return (
      <p className="text-sm text-[var(--muted)]">
        Read-only access — actions require the admin role.
      </p>
    );
  }

  function fire(action: (fd: FormData) => Promise<ActionResult>, fields: Record<string, string>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    const fd = new FormData();
    fd.set("userId", userId);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    startTransition(async () => {
      setResult(await action(fd));
    });
  }

  const btn =
    "rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm font-medium hover:bg-[var(--surface)] disabled:opacity-50";
  const dangerBtn =
    "rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-[var(--danger)] hover:bg-red-50 disabled:opacity-50";

  return (
    <div className="space-y-4">
      {result && (
        <p className={`text-sm ${result.ok ? "text-emerald-700" : "text-[var(--danger)]"}`}>
          {result.message}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {suspended ? (
          <button
            className={btn}
            disabled={pending}
            onClick={() => fire(unsuspendUser, {}, "Lift this user's suspension?")}
          >
            Unsuspend
          </button>
        ) : (
          <>
            <input
              value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
              placeholder="Suspension reason (internal)"
              className="w-56 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm"
            />
            <button
              className={dangerBtn}
              disabled={pending}
              onClick={() =>
                fire(suspendUser, { reason: suspendReason }, "Suspend this user? They will be unable to sign in.")
              }
            >
              Suspend
            </button>
          </>
        )}

        <button
          className={btn}
          disabled={pending}
          onClick={() => fire(forceSignOut, {}, "Sign this user out of all devices?")}
        >
          Force sign-out
        </button>

        <button
          className={btn}
          disabled={pending}
          onClick={() =>
            fire(
              setVerified,
              { verified: verified ? "false" : "true" },
              verified ? "Remove the Verified badge?" : "Manually mark this user Verified?",
            )
          }
        >
          {verified ? "Un-verify" : "Mark verified"}
        </button>

        {email && (
          <button
            className={btn}
            disabled={pending}
            onClick={() => fire(sendPasswordReset, {}, `Send a password-reset email to ${email}?`)}
          >
            Send password reset
          </button>
        )}

        <button
          className={btn}
          disabled={pending}
          onClick={() =>
            fire(
              resetProfileFields,
              { resetUsername: "on", resetBio: "on" },
              "Reset this user's username and clear their bio (policy violation)?",
            )
          }
        >
          Reset username/bio
        </button>

        {!emailConfirmed && (
          <button
            className={btn}
            disabled={pending}
            onClick={() => fire(confirmEmail, {}, "Manually mark this account's email confirmed (bypasses the confirmation link)?")}
          >
            Confirm email
          </button>
        )}

        {!student && (
          <button
            className={btn}
            disabled={pending}
            onClick={() => fire(grantStudent, {}, "Manually grant Student status (wrongly-rejected .edu)?")}
          >
            Grant student status
          </button>
        )}
      </div>

      {/* Change email — separate row, needs an input */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="new-email@example.com"
          className="w-64 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm"
        />
        <button
          className={btn}
          disabled={pending || !newEmail.includes("@")}
          onClick={() =>
            fire(changeEmail, { email: newEmail }, `Change this account's email to ${newEmail} (and confirm it)?`)
          }
        >
          Change email
        </button>
      </div>

      <div className="flex items-center gap-2 border-t border-[var(--line)] pt-4">
        <input
          value={deleteConfirm}
          onChange={(e) => setDeleteConfirm(e.target.value)}
          placeholder='Type DELETE to enable'
          className="w-44 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm"
        />
        <button
          className={dangerBtn}
          disabled={pending || deleteConfirm !== "DELETE"}
          onClick={() =>
            fire(
              deleteAccount,
              { confirmation: deleteConfirm },
              "PERMANENTLY delete this account, its data, and storage files? This cannot be undone.",
            )
          }
        >
          Delete account
        </button>
      </div>
    </div>
  );
}
