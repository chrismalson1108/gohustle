"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { useUser } from "@/lib/user";
import {
  getNotificationPrefs, saveNotificationPrefs, DEFAULT_NOTIF_PREFS, NOTIF_CATEGORIES, type NotifPrefs,
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
          "inline-block size-5 transform rounded-full bg-white shadow transition",
          checked ? "translate-x-[22px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export default function NotificationSettingsPage() {
  const router = useRouter();
  const { showToast } = useUser();
  const [prefs, setPrefs] = useState<NotifPrefs>(DEFAULT_NOTIF_PREFS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getNotificationPrefs()
      .then((p) => setPrefs(p))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggle = async (key: keyof NotifPrefs, value: boolean) => {
    const next = { ...prefs, [key]: value };
    setPrefs(next); // optimistic
    try {
      await saveNotificationPrefs(next);
    } catch {
      setPrefs(prefs); // revert
      showToast({ icon: "⚠️", title: "Couldn't update", message: "Please try again." });
    }
  };

  if (loading) return <FullPageSpinner />;

  return (
    <div>
      <PageHeader title="Notifications" subtitle="Choose how you hear about activity" variant="gold" />
      <PageContainer>
        <button onClick={() => router.push("/profile")} className="mb-4 flex items-center gap-1 text-sm font-bold text-primary">
          <ArrowLeft className="size-4" /> Back
        </button>

        <p className="mb-4 max-w-xl text-sm text-ink-soft">
          In-app alerts always show up in your <span className="font-semibold text-ink">Alerts</span> inbox. Push and email
          delivery are optional and can be set per category below.
        </p>

        <div className="max-w-xl space-y-3">
          {NOTIF_CATEGORIES.map((cat) => (
            <div key={cat.key} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
              <p className="font-bold text-ink">{cat.label}</p>
              <p className="mt-0.5 text-xs text-ink-muted">{cat.hint}</p>
              <div className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
                <label className="flex cursor-pointer items-center gap-2.5">
                  <Toggle
                    checked={prefs[`${cat.key}_push` as keyof NotifPrefs]}
                    onChange={(v) => toggle(`${cat.key}_push` as keyof NotifPrefs, v)}
                  />
                  <span className="text-sm font-semibold text-ink-soft">Push</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2.5">
                  <Toggle
                    checked={prefs[`${cat.key}_email` as keyof NotifPrefs]}
                    onChange={(v) => toggle(`${cat.key}_email` as keyof NotifPrefs, v)}
                  />
                  <span className="text-sm font-semibold text-ink-soft">Email</span>
                </label>
              </div>
            </div>
          ))}
        </div>
      </PageContainer>
    </div>
  );
}
