export default function SectionHeader({ label, title, subtitle, badge }) {
  return (
    <div className="flex items-start justify-between mb-4">
      <div>
        {label && (
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            {label}
          </div>
        )}
        <h3 className="text-lg font-semibold text-[var(--color-text-main)]">{title}</h3>
        {subtitle && (
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">{subtitle}</p>
        )}
      </div>
      {badge}
    </div>
  );
}
