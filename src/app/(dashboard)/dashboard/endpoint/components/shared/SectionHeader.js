export default function SectionHeader({ label, title, subtitle, badge }) {
  return (
    <div className="flex items-start justify-between mb-4">
      <div>
        {label && (
          <div className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-1">
            {label}
          </div>
        )}
        <h3 className="text-lg font-semibold text-text">{title}</h3>
        {subtitle && (
          <p className="text-sm text-text-muted mt-1">{subtitle}</p>
        )}
      </div>
      {badge}
    </div>
  );
}
