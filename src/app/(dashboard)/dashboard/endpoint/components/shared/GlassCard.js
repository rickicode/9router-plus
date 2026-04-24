export default function GlassCard({ children, className = "" }) {
  return (
    <div className={`relative overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface)] ${className}`}>
      <div className="relative p-4 md:p-6">
        {children}
      </div>
    </div>
  );
}
