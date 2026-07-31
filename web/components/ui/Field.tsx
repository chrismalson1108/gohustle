import React from "react";
import { classNames } from "@/lib/format";

// text-base (16px) at the small end is deliberate, not a style choice: iOS
// Safari force-zooms the page on focus for any input under 16px, which is why
// every text field in the product used to punch the viewport. Drops to the
// mobile app's 15px only from `sm` up, where no touch keyboard is involved.
// Radius is `xl` = 14px, the control step of the shared radius scale.
const base =
  "w-full rounded-xl border border-line bg-white px-4 py-3 text-base text-ink outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 placeholder:text-ink-muted disabled:opacity-60 sm:text-[15px]";

export function Label({
  children,
  className = "",
  htmlFor,
}: {
  children: React.ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <label htmlFor={htmlFor} className={classNames("mb-1.5 block text-sm font-bold text-ink", className)}>
      {children}
    </label>
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

// role="alert" so assistive tech announces the error the moment it appears — a
// silently-injected <p> is never read out (WCAG 4.1.3). Applies to every auth form
// that renders errors through this component.
export function FieldError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="mt-1.5 text-sm font-medium text-urgent">
      {children}
    </p>
  );
}

export function Field({
  label,
  error,
  children,
  hint,
  htmlFor,
}: {
  label?: string;
  error?: string | null;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      {label && <Label htmlFor={htmlFor}>{label}</Label>}
      {children}
      {hint && !error && <p className="mt-1.5 text-sm text-ink-muted">{hint}</p>}
      <FieldError>{error}</FieldError>
    </div>
  );
}
