export const STATUS_BADGE_CLASSES = {
  configured: "px-1.5 py-0.5 text-[10px] font-medium rounded-full border border-[var(--color-success)]/20 bg-[color:color-mix(in_srgb,var(--color-success)_12%,transparent)] text-[var(--color-success)]",
  notConfigured: "px-1.5 py-0.5 text-[10px] font-medium rounded-full border border-[var(--color-warning)]/20 bg-[color:color-mix(in_srgb,var(--color-warning)_12%,transparent)] text-[var(--color-warning)]",
  other: "px-1.5 py-0.5 text-[10px] font-medium rounded-full border border-[var(--color-info)]/20 bg-[color:color-mix(in_srgb,var(--color-info)_12%,transparent)] text-[var(--color-info)]",
  mitm: "px-1.5 py-0.5 text-[10px] font-medium rounded-full border border-[var(--color-info)]/20 bg-[color:color-mix(in_srgb,var(--color-info)_12%,transparent)] text-[var(--color-info)]",
};

export const ALERT_TONES = {
  info: {
    wrapper: "border-[var(--color-info)]/20 bg-[color:color-mix(in_srgb,var(--color-info)_10%,transparent)]",
    text: "text-[var(--color-info)]",
    icon: "text-[var(--color-info)]",
  },
  warning: {
    wrapper: "border-[var(--color-warning)]/20 bg-[color:color-mix(in_srgb,var(--color-warning)_10%,transparent)]",
    text: "text-[var(--color-warning)]",
    icon: "text-[var(--color-warning)]",
  },
  error: {
    wrapper: "border-[var(--color-danger)]/20 bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)]",
    text: "text-[var(--color-danger)]",
    icon: "text-[var(--color-danger)]",
  },
  success: {
    wrapper: "border-[var(--color-success)]/20 bg-[color:color-mix(in_srgb,var(--color-success)_10%,transparent)]",
    text: "text-[var(--color-success)]",
    icon: "text-[var(--color-success)]",
  },
};

export const PANEL_CLASS = "rounded border border-[var(--color-border)] bg-[var(--color-surface)]";
export const SOFT_PANEL_CLASS = "rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)]/50";
export const INPUT_CLASS = "flex-1 px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-xs text-[var(--color-text-main)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]/40";
export const INPUT_MD_CLASS = "w-full px-3 py-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]/40";
export const SELECT_TRIGGER_CLASS = "px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-xs text-[var(--color-text-main)] transition-colors hover:border-[var(--color-primary)]/40";
export const CHIP_CLASS = "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border border-[var(--color-border)] bg-[var(--color-bg-alt)] text-[var(--color-text-muted)]";
export const CODE_INLINE_CLASS = "px-1 rounded bg-[var(--color-bg-alt)] font-mono text-xs text-[var(--color-text-main)]";
export const CODE_BLOCK_CLASS = "block px-3 py-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] font-mono text-xs text-[var(--color-text-main)]";
export const FEEDBACK_CLASS = {
  success: "flex items-center gap-2 px-2 py-1.5 rounded text-xs border border-[var(--color-success)]/20 bg-[color:color-mix(in_srgb,var(--color-success)_10%,transparent)] text-[var(--color-success)]",
  error: "flex items-center gap-2 px-2 py-1.5 rounded text-xs border border-[var(--color-danger)]/20 bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] text-[var(--color-danger)]",
  warning: "flex items-center gap-2 px-2 py-1.5 rounded text-xs border border-[var(--color-warning)]/20 bg-[color:color-mix(in_srgb,var(--color-warning)_10%,transparent)] text-[var(--color-warning)]",
};
export const OVERLAY_CLASS = "fixed inset-0 z-50 flex items-center justify-center bg-black/50";
export const MODAL_PANEL_CLASS = "w-full max-w-sm rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-6";
export const ICON_BUTTON_DANGER_CLASS = "p-1 rounded text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-danger)]";
