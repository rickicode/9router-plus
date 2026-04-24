export const toneClasses = {
  success: {
    border: "border-[var(--color-success)]/20",
    bg: "bg-[color:color-mix(in_srgb,var(--color-success)_10%,transparent)]",
    text: "text-[var(--color-success)]",
  },
  warning: {
    border: "border-[var(--color-warning)]/20",
    bg: "bg-[color:color-mix(in_srgb,var(--color-warning)_10%,transparent)]",
    text: "text-[var(--color-warning)]",
  },
  danger: {
    border: "border-[var(--color-danger)]/20",
    bg: "bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)]",
    text: "text-[var(--color-danger)]",
  },
  info: {
    border: "border-[var(--color-info)]/20",
    bg: "bg-[color:color-mix(in_srgb,var(--color-info)_10%,transparent)]",
    text: "text-[var(--color-info)]",
  },
  muted: {
    border: "border-[var(--color-border)]",
    bg: "bg-[var(--color-bg-alt)]/60",
    text: "text-[var(--color-text-muted)]",
  },
};

export const inputClass = "w-full px-3 py-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]/40";
export const inputXsClass = "px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-xs text-[var(--color-text-main)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]/40";
export const softPanelClass = "rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)]/50";
export const rowHoverClass = "transition-colors hover:bg-[var(--color-bg-alt)]/40";
export const cardChromeClass = "rounded border border-[var(--color-border)] bg-[var(--color-surface)]";
export const subtleCodeClass = "font-mono text-xs rounded bg-[var(--color-bg-alt)] px-1.5 py-0.5 text-[var(--color-text-muted)]";
export const feedbackClass = {
  success: `rounded border px-4 py-3 ${toneClasses.success.border} ${toneClasses.success.bg} ${toneClasses.success.text}`,
  error: `rounded border px-4 py-3 ${toneClasses.danger.border} ${toneClasses.danger.bg} ${toneClasses.danger.text}`,
  warning: `rounded border px-4 py-3 ${toneClasses.warning.border} ${toneClasses.warning.bg} ${toneClasses.warning.text}`,
  info: `rounded border px-4 py-3 ${toneClasses.info.border} ${toneClasses.info.bg} text-[var(--color-text-main)]`,
  muted: `rounded border px-4 py-3 ${toneClasses.muted.border} ${toneClasses.muted.bg} ${toneClasses.muted.text}`,
};
