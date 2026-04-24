"use client";

import { useEffect } from "react";
import { cn } from "@/shared/utils/cn";

export default function Drawer({ 
  isOpen, 
  onClose, 
  title, 
  children, 
  width = "md",
  className 
}) {
  const widths = {
    sm: "w-[400px]",
    md: "w-[500px]",
    lg: "w-[600px]",
    xl: "w-[800px]",
    full: "w-full",
  };

  // Lock body scroll when drawer is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Overlay */}
      <div 
        className="absolute inset-0 cursor-pointer transition-opacity [background-color:var(--color-overlay,rgba(0,0,0,0.48))]" 
        onClick={onClose}
        aria-hidden="true"
      />
      
      {/* Drawer panel */}
      <div className={cn(
        "absolute right-0 top-0 flex h-full flex-col bg-[var(--color-surface)]",
        "animate-in slide-in-from-right duration-200",
        "border-l border-[var(--color-border)]",
        widths[width] || widths.md,
        className
      )}>
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] p-6">
          <div className="flex items-center gap-3">
            {title && (
              <h2 className="text-lg font-semibold text-[var(--color-text-main)]">
                {title}
              </h2>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-alt)] hover:text-[var(--color-text-main)]"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {children}
        </div>
      </div>
    </div>
  );
}
