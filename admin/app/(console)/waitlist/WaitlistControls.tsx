"use client";

import { useState, useTransition } from "react";
import { inviteCohort, exportWaitlist, deleteEntry, type ActionResult } from "./actions";
import ReauthPrompt from "../ReauthPrompt";
import { useStepUp } from "../useStepUp";

function Msg({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  return (
    <p className={`mt-2 text-sm ${result.ok ? "text-[var(--muted)]" : "text-[var(--danger)]"}`}>
      {result.message}
    </p>
  );
}

/**
 * Select rows, name the wave, invite.
 *
 * The selection lives here and the PREDICATE lives on the server — the action re-reads
 * every id and drops anyone unsubscribed regardless of what was ticked. A UI that
 * filtered opt-outs would put the one legally-shaped guarantee on this page behind a
 * checkbox nobody re-reads.
 */
export function InviteCohort({
  rows,
  canInvite,
}: {
  rows: { id: string; email: string; role_intent: string; in_launch_area: boolean | null }[];
  canInvite: boolean;
}) {
  const [pending, start] = useTransition();
  const stepUp = useStepUp();
  const result = stepUp.result;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [wave, setWave] = useState("");

  if (!canInvite) {
    return <p className="text-sm text-[var(--muted)]">Inviting requires the admin role.</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="text-sm text-[var(--muted)]">
        Nobody is waiting to be invited. This list is people who confirmed their email and
        haven&apos;t been invited yet.
      </p>
    );
  }

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allSelected = selected.size === rows.length;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
          className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm"
        >
          {allSelected ? "Clear selection" : `Select all ${rows.length}`}
        </button>
        <input
          value={wave}
          onChange={(e) => setWave(e.target.value)}
          placeholder="wave label (e.g. 'wave-1 ULM')"
          className="flex-1 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm"
        />
        <button
          disabled={pending || selected.size === 0}
          onClick={() => {
            const fd = new FormData();
            fd.set("ids", [...selected].join(","));
            fd.set("wave", wave);
            // Cleared INSIDE the thunk: useStepUp replays this exact call after a fresh
            // code, so a selection reset outside it would be gone on the retry.
            start(async () => {
              const r = await stepUp.run(() => inviteCohort(fd));
              if (r?.ok) setSelected(new Set());
            });
          }}
          className="rounded-lg bg-[var(--brand)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? "Inviting…" : `Invite ${selected.size || ""}`.trim()}
        </button>
      </div>

      <ul className="max-h-[420px] overflow-y-auto text-sm">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-3 border-t border-[var(--line)] py-2 first:border-0">
            <input
              type="checkbox"
              checked={selected.has(r.id)}
              onChange={() => toggle(r.id)}
              aria-label={`Select ${r.email}`}
            />
            <span className="min-w-0 flex-1 truncate">{r.email}</span>
            <span className="shrink-0 text-xs text-[var(--muted)]">
              {r.role_intent === "earn" ? "wants to work" : r.role_intent === "post" ? "needs help" : "both"}
              {r.in_launch_area === true ? " · local" : r.in_launch_area === false ? " · outside" : ""}
            </span>
          </li>
        ))}
      </ul>

      {stepUp.needed && <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />}
      <Msg result={result} />
    </div>
  );
}

/** Download the list. The scope is a server-side predicate, not whatever tab is open. */
export function ExportButton({ canExport }: { canExport: boolean }) {
  const [pending, start] = useTransition();
  const stepUp = useStepUp();
  const result = stepUp.result;

  if (!canExport) return null;

  // Hoisted out of go(), because the download has TWO arrival paths and the second one
  // is easy to miss: the first attempt, and the replay after a step-up code. Leaving it
  // inside the run() closure meant a stale-MFA export answered "N rows exported" and
  // produced no file — the operator's session was the one thing that decided whether the
  // button did what it said.
  function deliver(r?: ActionResult) {
    if (!r?.ok || !r.csv) return;
    // Built in the browser from the server's string — the file is never written
    // anywhere, and nothing about the list is cached by a CDN.
    const url = URL.createObjectURL(new Blob([r.csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = r.filename ?? "waitlist.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function go(scope: string) {
    const fd = new FormData();
    fd.set("scope", scope);
    start(async () => {
      // stepUp.run is typed to the narrow {ok, message} every guarded action shares.
      // The CSV rides along on this action's wider result, so widen it back here —
      // the value is the one exportWaitlist returned, not a reinterpretation.
      deliver((await stepUp.run(() => exportWaitlist(fd))) as ActionResult);
    });
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <button
          disabled={pending}
          onClick={() => go("invitable")}
          className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm disabled:opacity-50"
        >
          Export invitable
        </button>
        <button
          disabled={pending}
          onClick={() => go("all")}
          className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm disabled:opacity-50"
        >
          Export everyone confirmed
        </button>
      </div>
      {stepUp.needed && (
        <ReauthPrompt
          onVerified={() => stepUp.retry().then((r) => deliver(r as ActionResult | undefined))}
          onCancel={stepUp.cancel}
        />
      )}
      <Msg result={result} />
    </div>
  );
}

/** An erasure request from somebody with no account, so no other surface can serve it. */
export function DeleteEntry({ id, email, canDelete }: { id: string; email: string; canDelete: boolean }) {
  const [pending, start] = useTransition();
  const stepUp = useStepUp();
  const result = stepUp.result;

  if (!canDelete) return null;

  return (
    <>
      <button
        disabled={pending}
        onClick={() => {
          if (!window.confirm(`Permanently delete ${email} from the waitlist?\n\nThis also clears the suppression record — if they join again they are treated as new.`)) return;
          const fd = new FormData();
          fd.set("id", id);
          start(async () => {
            await stepUp.run(() => deleteEntry(fd));
          });
        }}
        className="text-xs text-[var(--danger)] hover:underline disabled:opacity-50"
      >
        {pending ? "Deleting…" : "Delete"}
      </button>
      {stepUp.needed && <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />}
      <Msg result={result} />
    </>
  );
}
