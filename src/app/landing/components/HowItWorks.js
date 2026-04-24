"use client";

export default function HowItWorks() {
  return (
    <section className="py-24 border-y border-[var(--color-border)] bg-[var(--color-bg-alt)]" id="how-it-works">
      <div className="max-w-7xl mx-auto px-6">
        <div className="mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-4 text-[var(--color-text-main)]">How 9Router Works</h2>
          <p className="text-[var(--color-text-muted)] max-w-xl text-lg">
            Data flows seamlessly from your application through our intelligent routing layer to the best provider for the job.
          </p>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 relative">
          {/* Connection line */}
          <div className="hidden md:block absolute top-12 left-[16%] right-[16%] h-[2px] bg-gradient-to-r from-zinc-300 via-[var(--color-primary)] to-zinc-300 -z-10 opacity-30"></div>
          
          {/* Step 1: CLI & SDKs */}
          <div className="flex flex-col gap-6 relative group">
            <div className="w-20 h-20 rounded bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center mx-auto md:mx-0 group-hover:border-[var(--color-accent)]/30 transition-all">
              <span className="material-symbols-outlined text-3xl text-[var(--color-text-muted)] group-hover:text-[var(--color-accent)] transition-colors">terminal</span>
            </div>
            <div>
              <h3 className="text-lg font-semibold mb-2 text-[var(--color-text-main)]">1. CLI &amp; SDKs</h3>
              <p className="text-sm text-[var(--color-text-muted)]">
                Your requests start from your favorite tools or our unified SDK. Just change the base URL.
              </p>
            </div>
          </div>

          {/* Step 2: 9Router Hub */}
          <div className="flex flex-col gap-6 relative group md:items-center md:text-center">
            <div className="w-20 h-20 rounded bg-[var(--color-primary)]/10 border-2 border-[var(--color-primary)] flex items-center justify-center z-10 mx-auto">
              <span className="material-symbols-outlined text-3xl text-[var(--color-accent)]">hub</span>
            </div>
            <div>
              <h3 className="text-lg font-semibold mb-2 text-[var(--color-accent)]">2. 9Router Hub</h3>
              <p className="text-sm text-[var(--color-text-muted)]">
                Our engine analyzes the prompt, checks provider health, and routes for lowest latency or cost.
              </p>
            </div>
          </div>

          {/* Step 3: AI Providers */}
          <div className="flex flex-col gap-6 relative group md:items-end md:text-right">
            <div className="w-20 h-20 rounded bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center mx-auto md:mx-0 group-hover:border-[var(--color-accent)]/30 transition-all">
              <div className="grid grid-cols-2 gap-2">
                <div className="w-6 h-6 rounded bg-[var(--color-primary)]/20"></div>
                <div className="w-6 h-6 rounded bg-emerald-500/20"></div>
                <div className="w-6 h-6 rounded bg-purple-500/20"></div>
                <div className="w-6 h-6 rounded bg-amber-500/20"></div>
              </div>
            </div>
            <div>
              <h3 className="text-lg font-semibold mb-2 text-[var(--color-text-main)]">3. AI Providers</h3>
              <p className="text-sm text-[var(--color-text-muted)]">
                The request is fulfilled by OpenAI, Anthropic, Gemini, or others instantly.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
