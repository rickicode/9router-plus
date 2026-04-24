export default function StatusBadge({ status, className = "" }) {
  const variants = {
    running: "border-[var(--color-success)]/20 bg-[var(--color-success)]/10 text-[var(--color-success)]",
    stopped: "border-[var(--color-border)] bg-[var(--color-bg-alt)] text-[var(--color-text-muted)]",
    error: "border-[var(--color-danger)]/20 bg-[var(--color-danger)]/10 text-[var(--color-danger)]",
    enabled: "border-[var(--color-primary)]/20 bg-[var(--color-primary)]/10 text-[var(--color-accent)]",
    disabled: "border-[var(--color-border)] bg-[var(--color-bg-alt)] text-[var(--color-text-muted)]",
  };

  const variant = variants[status.toLowerCase()] || variants.stopped;

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${variant} ${className}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}
