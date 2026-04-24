"use client";

export default function Footer() {
  return (
    <footer className="border-t border-[var(--color-border)] bg-[var(--color-surface)] pt-16 pb-8 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-8 mb-16">
          {/* Brand */}
          <div className="col-span-2 lg:col-span-2">
            <div className="flex items-center gap-3 mb-6">
              <div className="flex items-center justify-center w-9 h-9 rounded bg-[var(--color-primary)] text-white">
                <span className="material-symbols-outlined text-[20px]">hub</span>
              </div>
              <h3 className="text-[var(--color-text-main)] text-lg font-bold">9Router</h3>
            </div>
            <p className="text-[var(--color-text-muted)] text-sm max-w-xs mb-6">
              The unified endpoint for AI generation. Connect, route, and manage your AI providers with ease.
            </p>
            <div className="flex gap-4">
              <a className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors" href="https://github.com/decolua/9router" target="_blank" rel="noopener noreferrer">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.06 12.06 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
              </a>
            </div>
          </div>
          
          {/* Product */}
          <div className="flex flex-col gap-4">
            <h4 className="font-semibold text-[var(--color-text-main)]">Product</h4>
            <a className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] text-sm transition-colors" href="#features">Features</a>
            <a className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] text-sm transition-colors" href="/dashboard">Dashboard</a>
            <a className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] text-sm transition-colors" href="https://github.com/decolua/9router" target="_blank" rel="noopener noreferrer">Changelog</a>
          </div>
          
          {/* Resources */}
          <div className="flex flex-col gap-4">
            <h4 className="font-semibold text-[var(--color-text-main)]">Resources</h4>
            <a className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] text-sm transition-colors" href="https://github.com/decolua/9router#readme" target="_blank" rel="noopener noreferrer">Documentation</a>
            <a className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] text-sm transition-colors" href="https://github.com/decolua/9router" target="_blank" rel="noopener noreferrer">GitHub</a>
            <a className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] text-sm transition-colors" href="https://www.npmjs.com/package/9router" target="_blank" rel="noopener noreferrer">NPM</a>
          </div>
          
          {/* Legal */}
          <div className="flex flex-col gap-4">
            <h4 className="font-semibold text-[var(--color-text-main)]">Legal</h4>
            <a className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] text-sm transition-colors" href="https://github.com/decolua/9router/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">MIT License</a>
          </div>
        </div>
        
        {/* Bottom */}
        <div className="border-t border-[var(--color-border)] pt-8 flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-[var(--color-text-subtle)] text-sm">© 2025 9Router. All rights reserved.</p>
          <div className="flex gap-6">
            <a className="text-[var(--color-text-subtle)] hover:text-[var(--color-accent)] text-sm transition-colors" href="https://github.com/decolua/9router" target="_blank" rel="noopener noreferrer">GitHub</a>
            <a className="text-[var(--color-text-subtle)] hover:text-[var(--color-accent)] text-sm transition-colors" href="https://www.npmjs.com/package/9router" target="_blank" rel="noopener noreferrer">NPM</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
