export default function GlassCard({ children, className = "" }) {
  return (
    <div className={`relative overflow-hidden rounded-lg border border-white/10 bg-white/[0.02] dark:bg-white/[0.02] shadow-[0_8px_32px_rgba(0,0,0,0.12)] backdrop-blur-xl ${className}`}>
      <div className="pointer-events-none absolute inset-0 rounded-lg bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.18),transparent_35%),radial-gradient(circle_at_bottom_left,rgba(168,85,247,0.14),transparent_30%)]" />
      <div className="relative p-4 md:p-6">
        {children}
      </div>
    </div>
  );
}
