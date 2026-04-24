"use client";

import { cn } from "@/shared/utils/cn";

export default function SegmentedControl({
  options = [],
  value,
  onChange,
  size = "md",
  className,
}) {
  const sizes = {
    sm: "h-7 text-xs",
    md: "h-9 text-sm",
    lg: "h-11 text-base",
  };

  return (
    <div
      className={cn(
        "inline-flex items-center rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-1",
        className
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "px-4 rounded font-medium transition-all",
            sizes[size],
            value === option.value
              ? "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-main)]"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text-main)]"
          )}
        >
          {option.icon && (
            <span className="material-symbols-outlined text-[16px] mr-1.5">
              {option.icon}
            </span>
          )}
          {option.label}
        </button>
      ))}
    </div>
  );
}
