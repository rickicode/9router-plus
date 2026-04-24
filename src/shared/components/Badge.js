"use client";

import { cn } from "@/shared/utils/cn";

const variants = {
  default: "bg-[var(--color-bg-alt)] text-[var(--color-text-muted)]",
  primary: "bg-[var(--color-primary)]/10 text-[var(--color-accent)]",
  success: "bg-[var(--color-success)]/10 text-[var(--color-success)]",
  warning: "bg-[var(--color-warning)]/10 text-[var(--color-warning)]",
  error: "bg-[var(--color-danger)]/10 text-[var(--color-danger)]",
  info: "bg-[var(--color-info-soft)] text-[var(--color-info)]",
};

const sizes = {
  sm: "px-2 py-0.5 text-[10px]",
  md: "px-2.5 py-1 text-xs",
  lg: "px-3 py-1.5 text-sm",
};

export default function Badge({
  children,
  variant = "default",
  size = "md",
  dot = false,
  icon,
  className,
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded font-semibold",
        variants[variant],
        sizes[size],
        className
      )}
    >
      {dot && (
        <span
          className={cn(
            "size-1.5 rounded",
            variant === "success" && "bg-[var(--color-success)]",
            variant === "warning" && "bg-[var(--color-warning)]",
            variant === "error" && "bg-[var(--color-danger)]",
            variant === "info" && "bg-[var(--color-info)]",
            variant === "primary" && "bg-[var(--color-primary)]",
            variant === "default" && "bg-[var(--color-text-subtle)]"
          )}
        />
      )}
      {icon && <span className="material-symbols-outlined text-[14px]">{icon}</span>}
      {children}
    </span>
  );
}
