"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, Button, Toggle } from "@/shared/components";

/**
 * Card to manage the Codex provider's default instructions.
 *
 * Three states are exposed:
 *   1. Enabled + default mode  -> built-in CODEX_DEFAULT_INSTRUCTIONS is sent.
 *   2. Enabled + custom mode   -> contents of DATA_DIR/codex-instructions.md are sent.
 *   3. Disabled                -> empty string is sent (saves ~3000 tokens / request).
 *
 * Persisted via PUT /api/providers/codex/instructions.
 */
export default function CodexInstructionsCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [data, setData] = useState(null);

  // Editor state — what the user is currently typing.
  const [draft, setDraft] = useState("");
  const [draftMode, setDraftMode] = useState("default"); // "default" | "custom"
  const lastLoadedDraftRef = useRef("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/providers/codex/instructions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      // Seed the draft from whichever content best represents "currently in effect".
      const seed = json.mode === "custom" && json.customContent
        ? json.customContent
        : json.defaultContent;
      setDraft(seed);
      lastLoadedDraftRef.current = seed;
      setDraftMode(json.mode || "default");
    } catch (err) {
      setError(err?.message || "Failed to load Codex instructions settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const dirty = useMemo(() => {
    if (!data) return false;
    if (draftMode !== data.mode) return true;
    if (draftMode === "custom") {
      return draft !== (data.customContent || "");
    }
    // In default mode the textarea is informational; consider not dirty.
    return false;
  }, [data, draft, draftMode]);

  const isDefaultText = draftMode === "default" || (data && draft === data.defaultContent);

  const onToggleEnabled = useCallback(async (next) => {
    setSaving(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/providers/codex/instructions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      setData(json);
      setInfo(next
        ? "Codex default instructions enabled."
        : "Codex default instructions disabled. Sending empty instructions saves ~3000 tokens per request."
      );
    } catch (err) {
      setError(err?.message || "Failed to update");
    } finally {
      setSaving(false);
    }
  }, []);

  const onSaveCustom = useCallback(async () => {
    setSaving(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/providers/codex/instructions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft, mode: "custom" }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      setData(json);
      setDraft(json.customContent || "");
      lastLoadedDraftRef.current = json.customContent || "";
      setDraftMode(json.mode);
      setInfo(`Saved ${json.customLength.toLocaleString()} characters to ${json.filename}.`);
    } catch (err) {
      setError(err?.message || "Failed to save custom instructions");
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const onResetToDefault = useCallback(async () => {
    if (!confirm("Reset to built-in Codex default instructions? Any custom content will be deleted.")) return;
    setSaving(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/providers/codex/instructions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset: true, mode: "default" }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      setData(json);
      setDraft(json.defaultContent);
      lastLoadedDraftRef.current = json.defaultContent;
      setDraftMode(json.mode);
      setInfo("Reset to default. Custom file deleted.");
    } catch (err) {
      setError(err?.message || "Failed to reset");
    } finally {
      setSaving(false);
    }
  }, []);

  const onLoadDefaultIntoEditor = useCallback(() => {
    if (!data) return;
    setDraft(data.defaultContent);
    setDraftMode("custom");
    setInfo("Loaded default into the editor. Save to persist as a custom override.");
  }, [data]);

  if (loading) {
    return (
      <Card>
        <div className="py-6 text-sm text-text-muted">Loading Codex default instructions…</div>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <div className="py-6 text-sm text-red-500">{error || "Failed to load Codex instructions settings"}</div>
      </Card>
    );
  }

  const enabled = data.enabled;
  const tokenEstimate = Math.round(data.defaultLength / 3.6);

  return (
    <Card>
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-lg font-semibold">Codex Default Instructions</h2>
          <p className="text-sm text-text-muted mt-1">
            Controls the <code className="font-mono">instructions</code> field sent on every Codex request.
            Disabling sends an empty string and lets the Codex backend use its own default —
            saves ~{tokenEstimate.toLocaleString()} tokens (~{(data.defaultLength / 1024).toFixed(1)} KB) per request.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-sm text-text-muted">{enabled ? "Enabled" : "Disabled"}</span>
          <Toggle
            checked={enabled}
            onChange={(v) => onToggleEnabled(v)}
            disabled={saving}
          />
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-500 mb-3 break-words">{error}</p>
      )}
      {info && !error && (
        <p className="text-xs text-green-500 mb-3 break-words">{info}</p>
      )}

      {!enabled ? (
        <div className="rounded border border-border p-3 text-sm text-text-muted bg-bg-subtle">
          Sending empty <code className="font-mono">instructions</code>. The Codex backend
          will use its own server-side default. Re-enable to send a custom or built-in prompt.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-sm">
              Mode: <span className="font-medium">
                {data.mode === "custom" ? "Custom (.md file)" : "Built-in default"}
              </span>
              {data.mode === "custom" && data.hasCustomFile && (
                <span className="text-text-muted ml-2">
                  — {data.customLength.toLocaleString()} chars at <code className="font-mono">{data.filePath}</code>
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {data.mode === "default" && (
                <Button size="sm" variant="secondary" onClick={onLoadDefaultIntoEditor} disabled={saving}>
                  Edit as custom
                </Button>
              )}
              {data.mode === "custom" && (
                <Button size="sm" variant="secondary" onClick={onResetToDefault} disabled={saving}>
                  Reset to default
                </Button>
              )}
            </div>
          </div>

          <textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (draftMode !== "custom") setDraftMode("custom");
            }}
            spellCheck={false}
            disabled={saving}
            rows={20}
            className="w-full font-mono text-xs rounded border border-border bg-bg-input p-3 leading-relaxed"
            placeholder="Write your custom Codex instructions here…"
          />

          <div className="flex items-center justify-between gap-2 flex-wrap text-xs text-text-muted">
            <span>
              {draft.length.toLocaleString()} chars
              {data.mode === "default" && draft === data.defaultContent && " (built-in default — unchanged)"}
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setDraft(lastLoadedDraftRef.current);
                  setDraftMode(data.mode);
                  setInfo("");
                  setError("");
                }}
                disabled={saving || !dirty}
              >
                Discard
              </Button>
              <Button
                size="sm"
                onClick={onSaveCustom}
                disabled={saving || !dirty || draft.length === 0}
              >
                {saving ? "Saving…" : "Save as custom"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
