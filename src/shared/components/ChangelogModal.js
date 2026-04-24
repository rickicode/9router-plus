"use client";

import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { marked } from "marked";
import { GITHUB_CONFIG } from "@/shared/constants/config";

marked.setOptions({ gfm: true, breaks: true });

export default function ChangelogModal({ isOpen, onClose }) {
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const modalRef = useRef(null);

  useEffect(() => {
    if (!isOpen || html) return;
    setLoading(true);
    setError("");
    fetch(GITHUB_CONFIG.changelogUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((md) => setHtml(marked.parse(md)))
      .catch((err) => setError(err.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, [isOpen, html]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Overlay */}
      <div
        className="absolute inset-0 [background-color:var(--color-overlay,rgba(0,0,0,0.48))]"
        onClick={onClose}
      />

      {/* Modal content */}
      <div
        ref={modalRef}
        className="relative flex max-h-[85vh] w-full max-w-3xl flex-col rounded border border-[var(--color-border)] bg-[var(--color-surface)] animate-in fade-in zoom-in-95 duration-200"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border)] p-3">
          <h2 className="text-lg font-semibold text-[var(--color-text-main)]">Change Log</h2>
          <button
            onClick={onClose}
            className="rounded p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-alt)] hover:text-[var(--color-text-main)]"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto flex-1">
          {loading && (
            <div className="flex items-center justify-center py-10 text-[var(--color-text-muted)]">
              <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
              Loading...
            </div>
          )}
          {error && (
            <div className="py-4 text-[var(--color-danger)]">Failed to load changelog: {error}</div>
          )}
          {!loading && !error && html && (
            <div
              className="changelog-body text-[var(--color-text-main)]"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

ChangelogModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
