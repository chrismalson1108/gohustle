import { Loader2 } from "lucide-react";
import { classNames } from "@/lib/format";

export default function Spinner({ className = "" }: { className?: string }) {
  return <Loader2 className={classNames("animate-spin text-primary", className)} />;
}

export function FullPageSpinner({ label }: { label?: string }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3">
      <Spinner className="size-8" />
      {label && <p className="text-sm text-ink-muted">{label}</p>}
    </div>
  );
}
