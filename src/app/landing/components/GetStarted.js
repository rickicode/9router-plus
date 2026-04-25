"use client";

export default function GetStarted() {
  return (
    <section className="py-24 px-6 bg-[var(--color-surface)]">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col lg:flex-row gap-16 items-start">
          {/* Left: Steps */}
          <div className="flex-1">
            <h2 className="text-3xl md:text-4xl font-bold mb-4 text-[var(--color-text-main)]">Get Started in 30 Seconds</h2>
            <p className="text-[var(--color-text-muted)] text-lg mb-8">
              Install 9Router, configure your providers via web dashboard, and start routing AI requests.
            </p>
            
            <div className="flex flex-col gap-5">
              <div className="flex gap-4">
                <div className="flex-none w-8 h-8 rounded bg-[var(--color-primary)]/10 text-[var(--color-accent)] flex items-center justify-center font-semibold text-sm">1</div>
                <div>
                  <h4 className="font-semibold text-[15px] text-[var(--color-text-main)]">Install 9Router</h4>
                  <p className="text-sm text-[var(--color-text-muted)] mt-1">Run npx command to start the server instantly</p>
                </div>
              </div>
              
              <div className="flex gap-4">
                <div className="flex-none w-8 h-8 rounded bg-[var(--color-primary)]/10 text-[var(--color-accent)] flex items-center justify-center font-semibold text-sm">2</div>
                <div>
                  <h4 className="font-semibold text-[15px] text-[var(--color-text-main)]">Open Dashboard</h4>
                  <p className="text-sm text-[var(--color-text-muted)] mt-1">Configure providers and API keys via web interface</p>
                </div>
              </div>
              
              <div className="flex gap-4">
                <div className="flex-none w-8 h-8 rounded bg-[var(--color-primary)]/10 text-[var(--color-accent)] flex items-center justify-center font-semibold text-sm">3</div>
                <div>
                  <h4 className="font-semibold text-[15px] text-[var(--color-text-main)]">Route Requests</h4>
                  <p className="text-sm text-[var(--color-text-muted)] mt-1">Point your CLI tools to http://localhost:20128</p>
                </div>
              </div>
            </div>
          </div>

          {/* Right: Code block */}
          <div className="flex-1 w-full">
            <div className="rounded overflow-hidden bg-zinc-900 border border-[var(--color-border)]">
              {/* Terminal header */}
              <div className="flex items-center gap-2 px-4 py-3 bg-zinc-800/50 border-b border-[var(--color-border)]">
                <div className="w-3 h-3 rounded bg-[var(--color-danger)]/80"></div>
                <div className="w-3 h-3 rounded bg-yellow-500/80"></div>
                <div className="w-3 h-3 rounded bg-green-500/80"></div>
                <div className="ml-2 text-xs text-[var(--color-text-muted)] font-mono">bash</div>
              </div>
              
              {/* Terminal content */}
              <div className="p-5 font-mono text-sm leading-relaxed overflow-x-auto">
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-[var(--color-success)]">$</span>
                  <span className="text-zinc-200">npx 9router</span>
                </div>
                
                <div className="text-[var(--color-text-muted)] mb-5 space-y-1">
                  <div><span className="text-[var(--color-accent)]">&gt;</span> Starting 9Router...</div>
                  <div><span className="text-[var(--color-accent)]">&gt;</span> Server running on <span className="text-sky-400">http://localhost:20128</span></div>
                  <div><span className="text-[var(--color-accent)]">&gt;</span> Dashboard: <span className="text-sky-400">http://localhost:20128/dashboard</span></div>
                  <div><span className="text-[var(--color-success)]">&gt;</span> Ready to route!</div>
                </div>
                
                <div className="text-xs text-[var(--color-text-muted)] mb-3 border-t border-zinc-700/50 pt-4">
                  Configure providers in dashboard or use environment variables
                </div>
                
                <div className="text-[var(--color-text-muted)] text-xs space-y-0.5">
                  <div><span className="text-violet-400">Data Location:</span></div>
                  <div>  macOS/Linux: ~/.9router/db.sqlite</div>
                  <div>  Windows: %APPDATA%/9router/db.sqlite</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
