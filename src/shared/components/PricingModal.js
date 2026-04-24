"use client";

import { useState, useEffect } from "react";
import { getDefaultPricing, formatCost } from "@/shared/constants/pricing.js";

export default function PricingModal({ isOpen, onClose, onSave }) {
  const [pricingData, setPricingData] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadPricing();
    }
  }, [isOpen]);

  const loadPricing = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/pricing");
      if (response.ok) {
        const data = await response.json();
        setPricingData(data);
      } else {
        // Fallback to defaults
        const defaults = getDefaultPricing();
        setPricingData(defaults);
      }
    } catch (error) {
      console.error("Failed to load pricing:", error);
      const defaults = getDefaultPricing();
      setPricingData(defaults);
    } finally {
      setLoading(false);
    }
  };

  const handlePricingChange = (provider, model, field, value) => {
    const numValue = parseFloat(value);
    if (isNaN(numValue) || numValue < 0) return;

    setPricingData(prev => {
      const newData = { ...prev };
      if (!newData[provider]) newData[provider] = {};
      if (!newData[provider][model]) newData[provider][model] = {};
      newData[provider][model][field] = numValue;
      return newData;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/pricing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pricingData)
      });

      if (response.ok) {
        onSave?.();
        onClose();
      } else {
        const error = await response.json();
        alert(`Failed to save pricing: ${error.error}`);
      }
    } catch (error) {
      console.error("Failed to save pricing:", error);
      alert("Failed to save pricing");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!confirm("Reset all pricing to defaults? This cannot be undone.")) return;

    try {
      const response = await fetch("/api/pricing", { method: "DELETE" });
      if (response.ok) {
        const defaults = getDefaultPricing();
        setPricingData(defaults);
      }
    } catch (error) {
      console.error("Failed to reset pricing:", error);
      alert("Failed to reset pricing");
    }
  };

  if (!isOpen) return null;

  // Get all unique providers and models for display
  const allProviders = Object.keys(pricingData).sort();
  const pricingFields = ["input", "output", "cached", "reasoning", "cache_creation"];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 [background-color:var(--color-overlay,rgba(0,0,0,0.48))]">
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border)] p-4">
          <h2 className="text-xl font-semibold text-[var(--color-text-main)]">Pricing Configuration</h2>
          <button
            onClick={onClose}
            className="text-2xl leading-none text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-main)]"
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="py-8 text-center text-[var(--color-text-muted)]">Loading pricing data...</div>
          ) : (
            <div className="space-y-6">
              {/* Instructions */}
              <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-3 text-sm">
                <p className="mb-1 font-medium text-[var(--color-text-main)]">Pricing Rates Format</p>
                <p className="text-[var(--color-text-muted)]">
                  All rates are in <strong>dollars per million tokens</strong> ($/1M tokens).
                  Example: Input rate of 2.50 means $2.50 per 1,000,000 input tokens.
                </p>
              </div>

              {/* Pricing Tables */}
              {allProviders.map(provider => {
                const models = Object.keys(pricingData[provider]).sort();
                return (
                  <div key={provider} className="overflow-hidden rounded border border-[var(--color-border)]">
                    <div className="bg-[var(--color-bg-alt)] px-4 py-2 text-sm font-semibold text-[var(--color-text-main)]">
                      {provider.toUpperCase()}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[var(--color-bg-alt)] text-[var(--color-text-muted)] uppercase text-xs">
                          <tr>
                            <th className="px-3 py-2 text-left">Model</th>
                            <th className="px-3 py-2 text-right">Input</th>
                            <th className="px-3 py-2 text-right">Output</th>
                            <th className="px-3 py-2 text-right">Cached</th>
                            <th className="px-3 py-2 text-right">Reasoning</th>
                            <th className="px-3 py-2 text-right">Cache Creation</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--color-border)]">
                          {models.map(model => (
                            <tr key={model} className="hover:bg-[var(--color-bg-alt)]">
                              <td className="px-3 py-2 font-medium text-[var(--color-text-main)]">{model}</td>
                              {pricingFields.map(field => (
                                <td key={field} className="px-3 py-2">
                                  <input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={pricingData[provider][model][field] || 0}
                                    onChange={(e) => handlePricingChange(provider, model, field, e.target.value)}
                                    className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-right text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:outline-none"
                                  />
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}

              {allProviders.length === 0 && (
                <div className="py-8 text-center text-[var(--color-text-muted)]">
                  No pricing data available
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] p-4">
          <button
            onClick={handleReset}
            className="rounded border border-[var(--color-danger)]/20 px-4 py-2 text-sm text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger)]/10"
            disabled={saving}
          >
            Reset to Defaults
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded border border-[var(--color-border)] px-4 py-2 text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-main)]"
              disabled={saving}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="rounded bg-[var(--color-primary)] px-4 py-2 text-sm text-white transition-colors hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
              disabled={saving}
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
