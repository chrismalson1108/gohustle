import React from "react";
import { classNames } from "@/lib/format";

const base =
  "w-full rounded-2xl border border-line bg-white px-4 py-3 text-[15px] text-ink outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 placeholder:text-ink-muted disabled:opacity-60";

export function Label({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <label className={classNames("mb-1.5 block text-sm font-bold text-ink", className)}>{children}</label>
  );
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", ...rest }, ref) {
    return <input ref={ref} className={classNames(base, className)} {...rest} />;
  },
);

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className = "", ...rest }, ref) {
  return <textarea ref={ref} className={classNames(base, "min-h-[110px] resize-y", className)} {...rest} />;
});

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = "", children, ...rest }, ref) {
    return (
      <select ref={ref} className={classNames(base, "appearance-none pr-10", className)} {...rest}>
        {children}
      </select>
    );
  },
);

export function FieldError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return <p className="mt-1.5 text-sm font-medium text-urgent">{children}</p>;
}

export function Field({
  label,
  error,
  children,
  hint,
}: {
  label?: string;
  error?: string | null;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      {label && <Label>{label}</Label>}
      {children}
      {hint && !error && <p className="mt-1.5 text-sm text-ink-muted">{hint}</p>}
      <FieldError>{error}</FieldError>
    </div>
  );
}
