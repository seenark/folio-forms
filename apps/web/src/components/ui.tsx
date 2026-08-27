import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

import { cn } from "@/lib/utils";

export const Button = ({
  className,
  variant = "primary",
  size = "md",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
}) => {
  let sizeClass = "min-h-10 px-4 text-sm";
  if (size === "sm") {
    sizeClass = "min-h-9 px-3 text-sm";
  } else if (size === "lg") {
    sizeClass = "min-h-12 px-5 text-base";
  }

  let variantClass =
    "border-transparent bg-transparent text-[var(--ink-soft)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]";
  if (variant === "primary") {
    variantClass =
      "border-[var(--ink)] bg-[var(--ink)] text-[var(--paper)] hover:bg-[var(--ink-hover)]";
  } else if (variant === "secondary") {
    variantClass =
      "border-[var(--line-strong)] bg-[var(--paper)] text-[var(--ink)] hover:border-[var(--ink)]";
  } else if (variant === "danger") {
    variantClass =
      "border-[var(--danger)] bg-[var(--danger)] text-white hover:brightness-95";
  }

  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-[10px] border font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        sizeClass,
        variantClass,
        className
      )}
      {...props}
    />
  );
};

export const Card = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "rounded-[var(--radius)] border border-[var(--line)] bg-[var(--paper)] shadow-[var(--shadow-card)]",
      className
    )}
    {...props}
  />
);
export const Input = ({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) => (
  <input
    className={cn(
      "min-h-11 w-full rounded-[10px] border border-[var(--line-strong)] bg-[var(--paper)] px-3 text-[var(--ink)] shadow-sm placeholder:text-[var(--ink-soft)]/65 focus:border-[var(--ink)] focus:outline-none",
      className
    )}
    {...props}
  />
);
export const Textarea = ({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea
    className={cn(
      "w-full rounded-[10px] border border-[var(--line-strong)] bg-[var(--paper)] px-3 py-2 text-[var(--ink)] shadow-sm placeholder:text-[var(--ink-soft)]/65 focus:border-[var(--ink)] focus:outline-none",
      className
    )}
    {...props}
  />
);
export const Badge = ({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
}) => {
  let toneClass = "bg-[var(--muted)] text-[var(--ink-soft)]";
  if (tone === "success") {
    toneClass = "bg-[var(--success-soft)] text-[var(--success)]";
  } else if (tone === "warning") {
    toneClass = "bg-[var(--accent-soft)] text-[var(--ink)]";
  } else if (tone === "danger") {
    toneClass = "bg-[var(--danger-soft)] text-[var(--danger)]";
  }

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold",
        toneClass
      )}
    >
      {children}
    </span>
  );
};
export const Spinner = () => (
  <span
    className="inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
    aria-label="Loading"
  />
);
export const Notice = ({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "danger" | "success";
}) => {
  let role: "alert" | "status" = "status";
  let toneClass =
    "border-[var(--line)] bg-[var(--muted-soft)] text-[var(--ink-soft)]";
  if (tone === "danger") {
    role = "alert";
    toneClass =
      "border-[var(--danger)]/25 bg-[var(--danger-soft)] text-[var(--danger)]";
  } else if (tone === "success") {
    toneClass =
      "border-[var(--success)]/25 bg-[var(--success-soft)] text-[var(--success)]";
  }

  return (
    <div
      role={role}
      className={cn("rounded-[10px] border px-4 py-3 text-sm", toneClass)}
    >
      {children}
    </div>
  );
};
