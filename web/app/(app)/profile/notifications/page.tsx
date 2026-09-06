"use client";

import { useCallback, useEffect, useState } from "react";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { useUser } from "@/lib/user";
import {
  getNotificationPrefs, saveNotificationPref, NOTIF_CATEGORIES, type NotifPrefs,
} from "@/lib/notifications";
import { classNames } from "@/lib/format";

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={classNames(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition",
        checked ? "bg-primary" : "bg-line",
      )}
    >
      <span
        className={classNames(
          "inline-block size-5 transform rounded-full bg-white shadow-[var(--shadow-sm)] transition",
          checked ? "translate-x-[22px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export default function NotificationSettingsPage() {
  const { showToast } = useUser();
  const [prefs, setPrefs] = useState<NotifPrefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  // A failed load renders a retry, never the defaults: showing the defaults says
  // the user's opt-outs are gone, and the next toggle used to make that true.
  const load = useCallback(() => {
    getNotificationPrefs()
      .then((p) => { setPrefs(p); setLoadFailed(false); })
      .catch(() => { setPrefs(null); setLoadFailed(true); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const retry = () => { setLoading(true); load(); };

  const toggle = async (key: keyof NotifPrefs, value: boolean) => {
    if (!prefs) return;
    const previous = prefs;
    setPrefs({ ...prefs, [key]: value }); // optimistic
    try {
      await saveNotificationPref(key, value);
    } catch {
      setPrefs(previous); // revert
      showToast({ icon: "⚠️", title: "Couldn't update", message: "Please try again." });
    }
  };

  if (loading) return <FullPageSpinner />;

  if (loadFailed || !prefs) {
    return (
      <div>
        <PageHeader title="Notifications" subtitle="Choose how you hear about activity" width="form" back="/profile" />
        <PageContainer width="form">
          <div className="rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]">
            <p className="text-base font-bold tracking-[-0.2px] text-ink">Couldn&apos;t load your delivery settings</p>
            <p className="mt-2 text-sm leading-5 text-ink-soft">
              Nothing has changed — your saved choices are untouched. Check your connection and try again.
            </p>
            <button
              type="button"
              onClick={retry}
              className="mt-4 min-h-11 rounded-full bg-primary px-5 text-sm font-semibold text-white"
            >
              Try again
            </button>
          </div>
        </PageContainer>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Notifications" subtitle="Choose how you hear about activity" width="form" back="/profile" />
      {/* Width comes from the `form` measure, not a local max-w — the header and the
          container have to agree or the title floats out of line with the cards. */}
      <PageContainer width="form">
        <p className="mb-4 text-sm leading-5 text-ink-soft">
          In-app alerts always show up in your <span className="font-semibold text-ink">Alerts</span> inbox. Push and email
          delivery are optional and can be set per category below.
        </p>

        <div className="space-y-3 pb-8">
          {NOTIF_CATEGORIES.map((cat) => (
            <div key={cat.key} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
              <p className="text-base font-bold tracking-[-0.2px] text-ink">{cat.label}</p>
              <p className="mt-1 text-[13px] leading-[18px] text-ink-muted">{cat.hint}</p>
              <div className="mt-3 flex flex-wrap gap-x-8 gap-y-1">
                <label className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2.5">
                  <Toggle
                    checked={prefs[`${cat.key}_push` as keyof NotifPrefs]}
                    onChange={(v) => toggle(`${cat.key}_push` as keyof NotifPrefs, v)}
                  />
                  <span className="truncate text-sm font-medium text-ink-soft">Push</span>
                </label>
                <label className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2.5">
                  <Toggle
                    checked={prefs[`${cat.key}_email` as keyof NotifPrefs]}
                    onChange={(v) => toggle(`${cat.key}_email` as keyof NotifPrefs, v)}
                  />
                  <span className="truncate text-sm font-medium text-ink-soft">Email</span>
                </label>
              </div>
            </div>
          ))}
        </div>
      </PageContainer>
    </div>
  );
}
