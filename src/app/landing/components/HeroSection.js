"use client";

export default function HeroSection() {
  return (
    <section className="relative pt-24 pb-20 px-6 min-h-[85vh] flex flex-col items-center justify-center overflow-hidden">
      {/* Subtle background gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-[var(--color-primary)]/5 via-transparent to-transparent pointer-events-none" />
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-[var(--color-primary)]/8 rounded blur-[120px] pointer-events-none" />
      
      <div className="relative z-10 max-w-4xl w-full text-center flex flex-col items-center gap-8 animate-fade-in">
        {/* Version badge */}
        <div className="inline-flex items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)]/80 px-4 py-1.5 text-sm font-medium text-[var(--color-text-muted)]">
          <span className="flex h-2 w-2 rounded bg-[var(--color-primary)] animate-pulse" />
          v1.0 now available
        </div>

        {/* Main heading */}
        <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold leading-[1.1] tracking-tight text-[var(--color-text-main)]">
          One Endpoint for{" "}
          <span className="text-[var(--color-accent)]">All AI Providers</span>
        </h1>

        {/* Description */}
        <p className="text-lg md:text-xl text-[var(--color-text-muted)] max-w-2xl mx-auto leading-relaxed">
          Smart routing between Claude Code, Codex, Gemini CLI, and 40+ providers. Auto fallback, quota tracking, zero downtime.
        </p>

        {/* CTA Buttons */}
        <div className="flex flex-wrap items-center justify-center gap-4 w-full mt-4">
          <button className="h-11 px-8 rounded bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white text-sm font-semibold transition-all flex items-center gap-2 active:scale-[0.99]">
            <span className="material-symbols-outlined text-[20px]">rocket_launch</span>
            Get Started Free
          </button>
          <a 
            href="https://github.com/decolua/9router" 
            target="_blank" 
            rel="noopener noreferrer"
            className="h-11 px-8 rounded border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-bg-alt)] text-[var(--color-text-main)] text-sm font-semibold transition-all flex items-center gap-2"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.06 12.06 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
            View on GitHub
          </a>
        </div>

        {/* Quick stats */}
        <div className="flex items-center gap-8 mt-8 pt-8 border-t border-[var(--color-border)]">
          <div className="text-center">
            <div className="text-2xl font-bold text-[var(--color-text-main)]">40+</div>
            <div className="text-sm text-[var(--color-text-muted)]">Providers</div>
          </div>
          <div className="w-px h-8 bg-[var(--color-border)]" />
          <div className="text-center">
            <div className="text-2xl font-bold text-[var(--color-text-main)]">$0</div>
            <div className="text-sm text-[var(--color-text-muted)]">Start Free</div>
          </div>
          <div className="w-px h-8 bg-[var(--color-border)]" />
          <div className="text-center">
            <div className="text-2xl font-bold text-[var(--color-text-main)]">100+</div>
            <div className="text-sm text-[var(--color-text-muted)]">Models</div>
          </div>
        </div>
      </div>
    </section>
  );
}
