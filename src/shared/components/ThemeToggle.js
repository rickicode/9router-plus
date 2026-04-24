"use client";

import { useTheme } from "@/shared/hooks/useTheme";
import { cn } from "@/shared/utils/cn";

export default function ThemeToggle({ className, variant = "default" }) {
  const { theme, toggleTheme, isDark } = useTheme();

  const variants = {
    default: cn(
      "flex size-10 items-center justify-center rounded-full",
      "text-[var(--color-text-muted)]",
      "hover:bg-[var(--color-bg-alt)]",
      "hover:text-[var(--color-text-main)]",
      "transition-colors"
    ),
    card: cn(
      "flex size-11 items-center justify-center rounded-full",
      "border border-[var(--color-border)] bg-[var(--color-surface)]",
      "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-alt)] hover:text-[var(--color-primary)]",
      "transition-all group"
    ),
  };

  return (
    <button
      onClick={toggleTheme}
      className={cn(variants[variant], className)}
      aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
      title={`Switch to ${isDark ? "light" : "dark"} mode`}
    >
      <span
        className={cn(
          "material-symbols-outlined text-[22px]",
          variant === "card" && "transition-transform duration-300 group-hover:rotate-12"
        )}
      >
        {isDark ? "light_mode" : "dark_mode"}
      </span>
    </button>
  );
}
