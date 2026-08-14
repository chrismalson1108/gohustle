"use client";

import { useCallback, useEffect, useState } from "react";
import { CloudOff, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import Spinner, { FullPageSpinner } from "@/components/ui/Spinner";
import { useUser } from "@/lib/user";
import { fetchMemories, forgetMemory, forgetAllMemories } from "@/lib/assistantMemory";
import { classNames } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// Everything Hustlr AI has written down about you, and a way to take it back —
// the web half of src/screens/AssistantMemoryScreen.js.
//
// A stored fact is replayed into the system prompt of every future conversation,
// so until this page existed a web-only user's only way to remove one was to keep
// chatting until 25 newer facts pushed it out. "We told you in chat when we saved
// it" is not a control — it is model-generated text on a screen the user has
// already scrolled past, produced by the same model that would have to choose to
// mention it.
//
// So the two things this page owes are plain: show ALL of them, and let any one of
// them go in a single click.
// ─────────────────────────────────────────────────────────────────────────────

// Sentinel for the bulk action, so one `busy` value drives both spinners. The
// LEADING SPACE is what makes that safe: fetchMemories trims every stored fact, so
// no real one can ever equal this and disable the wrong control.
const CLEAR_ALL = " all";

export default function AssistantMemoryPage() {
  const { showToast } = useUser();

  // THREE states, not two. `null` is "we haven't got them yet" and `err` is "we asked
  // and failed" — collapsing either into an empty array tells someone nothing is
  // stored about them while it still is, which is the one wrong answer this page must
  // never give.
  const [memories, setMemories] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // the fact currently being removed
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    try {
      setMemories(await fetchMemories());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial async data load; setState runs after awaits, mirrors sibling pages
    load();
  }, [load]);

  const remove = async (fact: string) => {
    setBusy(fact);
    try {
      // forgetMemory re-reads before it writes, so a success here also means the read
      // path is working again — clear any stale-list banner an earlier failure left.
      setMemories(await forgetMemory(fact));
      setErr(null);
      // Quote it back. A mis-click on a small trash icon is otherwise invisible: the
      // row simply vanishes and the user cannot tell which one went.
      showToast({ icon: "🗑️", title: "Forgotten", message: `Hustlr AI won't remember “${fact}” any more.` });
    } catch (e) {
      showToast({ icon: "⚠️", title: "Couldn't delete that", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const clearAll = async () => {
    setBusy(CLEAR_ALL);
    try {
      setMemories(await forgetAllMemories());
      setErr(null);
      setConfirmClear(false);
      showToast({ icon: "🗑️", title: "Memory cleared", message: "Hustlr AI starts fresh from your next message." });
    } catch (e) {
      showToast({ icon: "⚠️", title: "Couldn't clear that", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="What Hustlr AI remembers"
        subtitle="Notes the assistant has saved about you"
        width="form"
        back="/settings"
        right={
          // Mobile re-reads this list every time the screen regains focus, because a
          // chat in the assistant sheet can add a fact while it sits in the back
          // stack. The web widget floats over this very page, so the page never loses
          // focus and there is nothing to hook — a manual refresh is the equivalent.
          // Disabled mid-write: a re-read landing after a delete would repaint the row
          // that was just removed.
          <button
            onClick={load}
            disabled={!!busy}
            className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold text-primary transition hover:bg-primary-light/60 disabled:opacity-50"
          >
            <RefreshCw className="size-4 shrink-0" /> Refresh
          </button>
        }
      />

      <PageContainer width="form" className="pb-10">
        <p className="mb-4 text-sm leading-5 text-ink-soft">
          Hustlr AI jots down short notes about you as you chat, and reads them back at the start of
          every new conversation so you don&apos;t have to repeat yourself. It keeps the 25 most
          recent. Delete anything you&apos;d rather it forgot.
        </p>

        {memories === null ? (
          err ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <CloudOff className="size-10 text-ink-muted" />
              <p className="font-bold text-ink">We couldn&apos;t load your notes</p>
              <p className="max-w-xs text-sm text-ink-soft">{err}</p>
              <Button variant="outline" className="mt-2" onClick={load}>
                Try again
              </Button>
            </div>
          ) : (
            <FullPageSpinner />
          )
        ) : (
          <>
            {/* A refresh that fails AFTER a good load must not throw the good list
                away. The whole point of this page is being able to see what is held,
                and a full-page error where a list used to be reads as "nothing is
                stored". */}
            {err && (
              <div className="mb-3 flex items-center gap-2 rounded-xl border border-line bg-white px-3 py-2.5">
                <CloudOff className="size-4 shrink-0 text-ink-soft" />
                <p className="min-w-0 flex-1 text-[13px] leading-[17px] text-ink-soft">
                  Couldn&apos;t refresh — this is the last list we loaded.
                </p>
              </div>
            )}

            {memories.length === 0 ? (
              <EmptyState
                icon={<Sparkles className="size-10" />}
                title="Nothing saved yet"
                body="When you tell Hustlr AI something worth keeping — a savings goal, the kind of gigs you want — it'll show up here."
              />
            ) : (
              <>
                <ul className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
                  {memories.map((fact, i) => (
                    // Keyed on index AND text: rows written before the assistant
                    // de-duped can still hold two identical strings side by side.
                    <li
                      key={`${i}-${fact}`}
                      className={classNames(
                        "flex items-center gap-3 px-4 py-3.5",
                        i !== memories.length - 1 && "border-b border-line",
                      )}
                    >
                      <p className="min-w-0 flex-1 text-[15px] leading-[21px] text-ink">{fact}</p>
                      {busy === fact ? (
                        <span className="-m-2 flex min-h-11 min-w-11 shrink-0 items-center justify-center">
                          <Spinner className="size-4" />
                        </span>
                      ) : (
                        <button
                          onClick={() => remove(fact)}
                          disabled={!!busy}
                          // The same explicit 44px box the Tax Center delete uses:
                          // padding around the glyph alone only reaches 36px, because
                          // preflight sets `svg { display: block }` and there is no
                          // line-box strut to help.
                          className="-m-2 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-urgent transition hover:bg-urgent/10 disabled:opacity-50"
                          aria-label={`Forget: ${fact}`}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>

                {/* Bulk delete is the one action here worth a second click — one stray
                    press should not wipe the lot. */}
                <Button variant="outline" fullWidth className="mt-4" disabled={!!busy} onClick={() => setConfirmClear(true)}>
                  {/* The urgent colour goes on the CHILDREN, not as an extra class on
                      the outline variant: two competing text-* utilities on one element
                      resolve by stylesheet order rather than by author intent, and
                      `outline` already sets text-ink. A colour applied directly to the
                      child always beats the parent's inherited one. */}
                  <Trash2 className="size-4 shrink-0 text-urgent" />
                  <span className="text-urgent">Forget everything</span>
                </Button>
              </>
            )}
          </>
        )}
      </PageContainer>

      <Modal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title={`Forget all ${memories?.length ?? 0} notes?`}
        size="sm"
        footer={
          <div className="flex gap-2">
            <Button variant="outline" fullWidth onClick={() => setConfirmClear(false)}>
              Keep them
            </Button>
            <Button
              variant="danger"
              fullWidth
              loading={busy === CLEAR_ALL}
              // ANY write in flight, not just a clear-all: a per-row delete racing this
              // one can land last and restore the facts this claims to have erased. On a
              // privacy screen, saying data is gone when it is not is the error that
              // matters.
              disabled={!!busy}
              onClick={clearAll}
            >
              Forget everything
            </Button>
          </div>
        }
      >
        <p className="text-sm text-ink-soft">
          This can&apos;t be undone. Hustlr AI will start over, and may ask you things it already
          knew.
        </p>
      </Modal>
    </div>
  );
}
