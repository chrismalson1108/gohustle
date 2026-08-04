"use client";

import { useState, useTransition } from "react";
import { inviteEmails, revokeEmail, setOpenBeta, type ActionResult } from "./actions";

function Msg({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  return (
    <p className={`mt-2 text-sm ${result.ok ? "text-[var(--muted)]" : "text-[var(--danger)]"}`}>
      {result.message}
    </p>
  );
}

export function InviteForm({ isAdmin }: { isAdmin: boolean }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [emails, setEmails] = useState("");
  const [note, setNote] = useState("");

  if (!isAdmin) return <p className="text-sm text-[var(--muted)]">Inviting requires the admin role.</p>;

  return (
    <div>
      <textarea
        value={emails}
        onChange={(e) => setEmails(e.target.value)}
        rows={3}
        placeholder="one@school.edu, two@school.edu — commas, spaces or newlines"
        className="w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="note (e.g. 'UCLA cohort 2')"
          className="flex-1 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm"
        />
        <button
          onClick={() => {
            const fd = new FormData();
            fd.set("emails", emails);
            fd.set("note", note);
            start(async () => {
              const r = await inviteEmails(fd);
              setResult(r);
              if (r.ok) setEmails("");
            });
          }}
          disabled={pending || !emails.trim()}
          className="rounded-lg bg-[var(--brand)] px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Inviting…" : "Invite"}
        </button>
      </div>
      <Msg result={result} />
    </div>
  );
}

export function RevokeButton({ email, isAdmin }: { email: string; isAdmin: boolean }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  if (!isAdmin) return null;
  return (
    <span className="flex items-center gap-2">
      <button
        onClick={() => {
          if (!confirm(`Revoke the invite for ${email}?`)) return;
          const fd = new FormData();
          fd.set("email", email);
          start(async () => setResult(await revokeEmail(fd)));
        }}
        disabled={pending}
        className="rounded-lg border border-[var(--line)] px-2.5 py-1 text-xs hover:bg-[var(--surface)] disabled:opacity-50"
      >
        Revoke
      </button>
      {result && !result.ok && <span className="text-xs text-[var(--danger)]">{result.message}</span>}
    </span>
  );
}

// The open/closed switch. Typed confirmation in BOTH directions: opening exposes
// signup to the whole internet, closing silently blocks every prospective user.
// Neither belongs behind a single click.
export function OpenBetaControl({ open, isAdmin }: { open: boolean; isAdmin: boolean }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const next = !open;
  const word = next ? "OPEN" : "CLOSE";

  if (!isAdmin) {
    return (
      <p className="text-sm text-[var(--muted)]">
        Signups are currently <strong>{open ? "open to everyone" : "invite-only"}</strong>. Changing this requires the admin role.
      </p>
    );
  }

  return (
    <div>
      <p className="text-sm">
        Signups are currently{" "}
        <strong className={open ? "text-[var(--danger)]" : ""}>
          {open ? "OPEN to everyone" : "INVITE-ONLY"}
        </strong>
        .{" "}
        {open
          ? "Anyone with the app can create an account."
          : "Only addresses on the list below can create an account."}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          placeholder={`type ${word}`}
          className="w-32 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm"
        />
        <button
          onClick={() => {
            const fd = new FormData();
            fd.set("open", String(next));
            fd.set("confirmation", confirmation);
            start(async () => {
              const r = await setOpenBeta(fd);
              setResult(r);
              if (r.ok) setConfirmation("");
            });
          }}
          disabled={pending || confirmation !== word}
          className="rounded-lg bg-[var(--brand)] px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {next ? "Open signups to everyone" : "Close to invite-only"}
        </button>
      </div>
      <Msg result={result} />
    </div>
  );
}
