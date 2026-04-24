function LoadingSpinner() {
  return (
    <div className="flex items-center gap-3 text-[var(--color-text-main)]">
      <span
        className="material-symbols-outlined animate-spin text-[22px]"
        aria-hidden="true"
      >
        progress_activity
      </span>
      <span className="text-sm tracking-tight">Loading...</span>
    </div>
  );
}

export default function DashboardGroupLoading() {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-6 text-[var(--color-text-main)]"
      style={{ fontFamily: "'Berkeley Mono', 'IBM Plex Mono', ui-monospace, monospace" }}
    >
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-8 py-7 shadow-sm">
        <LoadingSpinner />
      </div>
    </div>
  );
}
