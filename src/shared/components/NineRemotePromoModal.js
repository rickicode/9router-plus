"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

const FEATURES = [
  { icon: "terminal", label: "Terminal", desc: "Full shell access" },
  { icon: "cast", label: "Desktop", desc: "Screen sharing" },
  { icon: "folder_open", label: "Files", desc: "Browse & edit files" },
];

const BULLETS = [
  { icon: "qr_code_scanner", text: "Scan QR to connect instantly" },
  { icon: "wifi_off", text: "No port forwarding needed" },
  { icon: "devices", text: "Works on any device" },
];

const NINE_REMOTE_URL = "https://9remote.cc";

export default function NineRemotePromoModal({ isOpen, onClose }) {
  useEffect(() => {
    if (!isOpen) return;
    document.body.style.overflow = "hidden";
    const onEsc = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onEsc);
    return () => { document.body.style.overflow = ""; document.removeEventListener("keydown", onEsc); };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 [background-color:var(--color-overlay,rgba(0,0,0,0.56))]" onClick={onClose} />

      <div className="relative flex w-full max-w-sm flex-col overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface)] animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-7 w-7 items-center justify-center rounded [background-color:var(--color-primary)]">
              <span className="material-symbols-outlined text-white text-base">terminal</span>
            </div>
            <span className="text-xs font-bold uppercase tracking-wider text-[var(--color-primary)]" style={{ fontFamily: "monospace" }}>9Remote</span>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-main)]"
          >
            <span className="material-symbols-outlined text-base">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="px-7 py-7 pb-9 flex flex-col gap-6">
          {/* Hero */}
          <div className="flex flex-col items-center gap-2 text-center mt-2">
            <div
              className="mb-1 flex h-14 w-14 items-center justify-center rounded [background-color:var(--color-primary)]"
            >
              <span className="material-symbols-outlined text-white" style={{ fontSize: 30 }}>terminal</span>
            </div>
            <h1 className="text-lg font-bold tracking-tight text-[var(--color-text-main)]">9Remote</h1>
            <p className="max-w-[220px] text-xs leading-5 text-[var(--color-text-muted)]">
              Access your terminal, desktop &amp; files from anywhere
            </p>
          </div>

          {/* Feature cards */}
          <div className="flex gap-2 w-full">
            {FEATURES.map(({ icon, label, desc }) => (
              <div key={label} className="flex flex-1 flex-col items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-1 py-4">
                <span className="material-symbols-outlined text-[var(--color-primary)]" style={{ fontSize: 22 }}>{icon}</span>
                <p className="text-xs font-semibold text-[var(--color-text-main)]">{label}</p>
                <p className="text-center text-[10px] leading-4 text-[var(--color-text-muted)]">{desc}</p>
              </div>
            ))}
          </div>

          {/* Bullets */}
          <div className="flex flex-col gap-3 w-full">
            {BULLETS.map(({ icon, text }) => (
              <div key={icon} className="flex items-center gap-2.5">
                <span className="material-symbols-outlined shrink-0 text-[var(--color-primary)]" style={{ fontSize: 16 }}>{icon}</span>
                <span className="text-xs text-[var(--color-text-muted)]">{text}</span>
              </div>
            ))}
          </div>

          {/* CTA */}
          <button
            onClick={() => window.open(NINE_REMOTE_URL, "_blank")}
            className="flex w-full items-center justify-center gap-2 rounded bg-[var(--color-primary)] py-3.5 text-sm font-semibold text-white transition-all hover:bg-[var(--color-primary-hover)] active:scale-[0.98]"
          >
            <span className="material-symbols-outlined text-base">open_in_new</span>
            Get 9Remote
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
