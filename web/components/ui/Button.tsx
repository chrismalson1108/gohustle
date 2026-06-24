import React from "react";
import { Loader2 } from "lucide-react";
import { classNames } from "@/lib/format";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-primary text-white hover:bg-primary-dark shadow-[var(--shadow-soft)]",
  secondary: "bg-primary-light text-primary hover:bg-[#e3dcfa]",
  ghost: "bg-transparent text-ink-soft hover:bg-primary-light/60",
  outline: "bg-white text-ink border border-line hover:border-primary hover:text-primary",
  danger: "bg-urgent text-white hover:brightness-95",
};

const SIZES: Record<Size, string> = {
  sm: "h-9 px-3 text-sm rounded-xl",
  md: "h-11 px-5 text-[15px] rounded-2xl",
  lg: "h-13 px-6 text-base rounded-2xl",
};

export function buttonClasses(variant: Variant = "primary", size: Size = "md", extra = ""): string {
  return classNames(
    "inline-flex items-center justify-center gap-2 font-bold transition-all active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none cursor-pointer select-none",
    VARIANTS[variant],
    SIZES[size],
    extra,
  );
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
}

export default function Button({
  variant = "primary",
  size = "md",
  loading = false,
  fullWidth = false,
  className = "",
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={buttonClasses(variant, size, classNames(fullWidth && "w-full", className))}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}
