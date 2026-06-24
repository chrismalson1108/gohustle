import { classNames } from "@/lib/format";

// Gradient screen header used across app pages (mirror of mobile GradientHeader).
export default function PageHeader({
  title,
  subtitle,
  variant = "brand",
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  variant?: "brand" | "earn" | "gold";
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const bg = variant === "earn" ? "bg-earn" : variant === "gold" ? "bg-gold" : "bg-brand";
  return (
    <header className={classNames(bg, "px-5 pb-6 pt-8 text-white md:rounded-b-[2rem]")}>
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-black">{title}</h1>
            {subtitle && <p className="text-sm text-white/75">{subtitle}</p>}
          </div>
          {right}
        </div>
        {children}
      </div>
    </header>
  );
}

export function PageContainer({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={classNames("mx-auto w-full max-w-3xl px-5 py-5", className)}>{children}</div>;
}

export function EmptyState({ icon, title, body }: { icon?: React.ReactNode; title: string; body?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      {icon && <div className="text-ink-muted">{icon}</div>}
      <p className="font-bold text-ink">{title}</p>
      {body && <p className="max-w-xs text-sm text-ink-soft">{body}</p>}
    </div>
  );
}
