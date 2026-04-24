function SkeletonBlock({ className = "" }) {
  return <div className={`animate-pulse rounded-md bg-[var(--color-bg-alt)] ${className}`} />;
}

function SidebarSkeleton() {
  return (
    <aside className="hidden w-72 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] lg:flex lg:flex-col">
      <div className="flex items-center gap-3 px-6 py-4">
        <SkeletonBlock className="h-9 w-9 rounded-lg" />
        <div className="flex-1 space-y-2">
          <SkeletonBlock className="h-4 w-24" />
          <SkeletonBlock className="h-3 w-16" />
        </div>
      </div>
      <div className="flex-1 space-y-2 px-4 py-3">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3 rounded px-4 py-2.5">
            <SkeletonBlock className="h-4 w-4 rounded-sm" />
            <SkeletonBlock className="h-4 flex-1" />
          </div>
        ))}
      </div>
    </aside>
  );
}

function DashboardContentSkeleton() {
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[var(--color-bg)] text-[var(--color-text-main)]">
      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 lg:px-6">
        <div className="flex items-center justify-between gap-4">
          <SkeletonBlock className="h-9 w-9 rounded-lg lg:hidden" />
          <SkeletonBlock className="h-5 w-40" />
          <SkeletonBlock className="h-9 w-24 rounded-lg" />
        </div>
      </div>

      <div className="flex-1 overflow-hidden p-6 lg:p-10">
        <div className="mx-auto flex max-w-7xl flex-col gap-6">
          <div className="grid gap-4 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div
                key={index}
                className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
              >
                <SkeletonBlock className="mb-4 h-4 w-24" />
                <SkeletonBlock className="h-8 w-20" />
              </div>
            ))}
          </div>

          <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
              <SkeletonBlock className="mb-5 h-5 w-48" />
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, index) => (
                  <SkeletonBlock key={index} className="h-12 w-full" />
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
              <SkeletonBlock className="mb-5 h-5 w-32" />
              <div className="space-y-4">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="space-y-2">
                    <SkeletonBlock className="h-3 w-20" />
                    <SkeletonBlock className="h-10 w-full" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

export default function DashboardLoading() {
  return (
    <div className="flex min-h-screen w-full overflow-hidden bg-[var(--color-bg)] text-[var(--color-text-main)]">
      <SidebarSkeleton />
      <DashboardContentSkeleton />
    </div>
  );
}
