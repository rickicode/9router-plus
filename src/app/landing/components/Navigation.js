"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Navigation() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const router = useRouter();

  return (
    <nav className="fixed top-0 z-50 w-full bg-[var(--color-surface)]/80 border-b border-[var(--color-border)]">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        {/* Logo */}
        <button
          type="button"
          className="flex items-center gap-3 cursor-pointer bg-transparent border-none p-0"
          onClick={() => router.push("/")}
          aria-label="Navigate to home"
        >
          <div className="flex items-center justify-center w-9 h-9 rounded bg-[var(--color-primary)] text-white">
            <span className="material-symbols-outlined text-[20px]">hub</span>
          </div>
          <h2 className="text-[var(--color-text-main)] text-xl font-bold tracking-tight">9Router</h2>
        </button>

        {/* Desktop menu */}
        <div className="hidden md:flex items-center gap-8">
          <a className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] text-sm font-medium transition-colors" href="#features">Features</a>
          <a className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] text-sm font-medium transition-colors" href="#how-it-works">How it Works</a>
          <a className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] text-sm font-medium transition-colors" href="https://github.com/decolua/9router#readme" target="_blank" rel="noopener noreferrer">Docs</a>
          <a className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] text-sm font-medium transition-colors flex items-center gap-1" href="https://github.com/decolua/9router" target="_blank" rel="noopener noreferrer">
            GitHub <span className="material-symbols-outlined text-[14px]">open_in_new</span>
          </a>
        </div>

        {/* CTA + Mobile menu */}
        <div className="flex items-center gap-4">
          <button 
            onClick={() => router.push("/dashboard")}
            className="hidden sm:flex h-9 items-center justify-center rounded px-5 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] transition-all text-white text-sm font-semibold cursor-pointer"
          >
            Get Started
          </button>
          <button 
            className="md:hidden p-2 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] transition-colors cursor-pointer"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            <span className="material-symbols-outlined">{mobileMenuOpen ? "close" : "menu"}</span>
          </button>
        </div>
      </div>

      {/* Mobile menu dropdown */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-[var(--color-border)] bg-[var(--color-surface)]/95">
          <div className="flex flex-col gap-4 p-6">
            <a className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] text-sm font-medium transition-colors" href="#features" onClick={() => setMobileMenuOpen(false)}>Features</a>
            <a className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] text-sm font-medium transition-colors" href="#how-it-works" onClick={() => setMobileMenuOpen(false)}>How it Works</a>
            <a className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] text-sm font-medium transition-colors" href="https://github.com/decolua/9router#readme" target="_blank" rel="noopener noreferrer">Docs</a>
            <a className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] text-sm font-medium transition-colors" href="https://github.com/decolua/9router" target="_blank" rel="noopener noreferrer">GitHub</a>
            <button 
              onClick={() => router.push("/dashboard")}
              className="h-10 rounded bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white text-sm font-semibold cursor-pointer"
            >
              Get Started
            </button>
          </div>
        </div>
      )}
    </nav>
  );
}
