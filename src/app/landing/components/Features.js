"use client";

const FEATURES = [
  { 
    icon: "link", 
    title: "Unified Endpoint", 
    desc: "Access all providers via a single standard API URL.",
    color: "primary"
  },
  { 
    icon: "bolt", 
    title: "Easy Setup", 
    desc: "Get up and running in minutes with simple configuration.",
    color: "emerald"
  },
  { 
    icon: "shield_with_heart", 
    title: "Model Fallback", 
    desc: "Automatically switch providers on failure or high latency.",
    color: "rose"
  },
  { 
    icon: "monitoring", 
    title: "Usage Tracking", 
    desc: "Detailed analytics and cost monitoring across all models.",
    color: "purple"
  },
  { 
    icon: "key", 
    title: "OAuth & API Keys", 
    desc: "Securely manage credentials in one vault.",
    color: "amber"
  },
  { 
    icon: "cloud_sync", 
    title: "Cloud Sync", 
    desc: "Sync your configurations across devices instantly.",
    color: "sky"
  },
  { 
    icon: "terminal", 
    title: "CLI Support", 
    desc: "Works with Claude Code, Codex, Cline, Cursor, and more.",
    color: "emerald"
  },
  { 
    icon: "dashboard", 
    title: "Dashboard", 
    desc: "Visual dashboard for real-time traffic analysis.",
    color: "fuchsia"
  },
];

const colorMap = {
  primary: { bg: "bg-[var(--color-primary)]/10", text: "text-[var(--color-accent)]", border: "hover:border-[var(--color-accent)]/30" },
  emerald: { bg: "bg-[var(--color-success)]/10", text: "text-[var(--color-success)]", border: "hover:border-[var(--color-success)]/30" },
  rose: { bg: "bg-rose-500/10", text: "text-rose-500", border: "hover:border-rose-500/30" },
  purple: { bg: "bg-purple-500/10", text: "text-purple-500", border: "hover:border-purple-500/30" },
  amber: { bg: "bg-[var(--color-warning)]/10", text: "text-[var(--color-warning)]", border: "hover:border-[var(--color-warning)]/30" },
  sky: { bg: "bg-sky-500/10", text: "text-sky-500", border: "hover:border-sky-500/30" },
  fuchsia: { bg: "bg-fuchsia-500/10", text: "text-fuchsia-500", border: "hover:border-fuchsia-500/30" },
};

export default function Features() {
  return (
    <section className="py-24 px-6 bg-[var(--color-bg-alt)]" id="features">
      <div className="max-w-7xl mx-auto">
        <div className="mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-4 text-[var(--color-text-main)]">Powerful Features</h2>
          <p className="text-[var(--color-text-muted)] max-w-xl text-lg">
            Everything you need to manage your AI infrastructure in one place, built for scale.
          </p>
        </div>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {FEATURES.map((feature) => {
            const c = colorMap[feature.color];
            return (
              <div 
                key={feature.title}
                className={`p-5 rounded border border-[var(--color-border)] ${c.border} hover:bg-[var(--color-surface)]/80 transition-all duration-200 group`}
              >
                <div className={`w-10 h-10 rounded ${c.bg} flex items-center justify-center mb-4 ${c.text} group-hover:scale-110 transition-transform duration-200`}>
                  <span className="material-symbols-outlined">{feature.icon}</span>
                </div>
                <h3 className="text-[15px] font-semibold mb-2 text-[var(--color-text-main)] group-hover:text-[var(--color-accent)] transition-colors">
                  {feature.title}
                </h3>
                <p className="text-sm text-[var(--color-text-muted)] leading-relaxed">{feature.desc}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
