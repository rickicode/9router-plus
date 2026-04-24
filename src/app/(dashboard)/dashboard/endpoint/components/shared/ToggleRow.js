import { Toggle } from "@/shared/components";

export default function ToggleRow({ label, description, checked, onChange, disabled = false }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-4 py-4">
      <div className="flex-1">
        <div className="text-sm font-medium text-[var(--color-text-main)]">{label}</div>
        {description && (
          <div className="mt-1 text-xs text-[var(--color-text-muted)]">{description}</div>
        )}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}
