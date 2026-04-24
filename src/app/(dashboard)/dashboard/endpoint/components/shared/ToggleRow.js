import { Toggle } from "@/shared/components";

export default function ToggleRow({ label, description, checked, onChange, disabled = false }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-white/8 bg-black/10 px-4 py-4 shadow-inner shadow-black/10 backdrop-blur-sm">
      <div className="flex-1">
        <div className="text-sm font-medium text-text">{label}</div>
        {description && (
          <div className="text-xs text-text-muted mt-1">{description}</div>
        )}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}
