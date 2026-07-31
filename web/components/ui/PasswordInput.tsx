"use client";

import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "./Field";

// Password field with a show/hide toggle. Forwards every native input prop
// (value, onChange, placeholder, autoComplete, …) to the underlying Input.
export const PasswordInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">
>(function PasswordInput({ className = "", ...rest }, ref) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        ref={ref}
        type={show ? "text" : "password"}
        className={`pr-11 ${className}`}
        {...rest}
      />
      {/* The toggle fills the full height of the field and a 44px column at its
          right edge — as a bare 20px icon its hit area was less than a quarter of
          the touch-target minimum, on the one control every sign-in taps. The
          input's matching `pr-11` keeps the masked text clear of it. */}
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide password" : "Show password"}
        aria-pressed={show}
        className="absolute inset-y-0 right-0 flex w-11 cursor-pointer items-center justify-center text-ink-muted transition hover:text-primary"
      >
        {show ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
      </button>
    </div>
  );
});

export default PasswordInput;
