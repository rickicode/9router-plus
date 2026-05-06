"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, Button, Toggle } from "@/shared/components";

export default function CommandCodeInstructionsCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState("");
  const [draftMode, setDraftMode] = useState("default");
  const lastLoadedDraftRef = useRef("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/providers/commandcode/instructions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      const seed = json.mode === "custom"
        ? (json.customContent || "")
        : json.defaultContent;
      setDraft(seed);
      lastLoadedDraftRef.current = seed;
      setDraftMode(json.mode || "default");
    } catch (err) {
      setError(err?.message || "Failed to load Command Code instructions settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const dirty = useMemo(() => {
    if (!data) return false;
    if (draftMode !== data.mode) return true;
    if (draftMode === "custom") return draft !== (data.customContent || "");
    return false;
  }, [data, draft, draftMode]);

  const onToggleEnabled = useCallback(async (next) => {
    setSaving(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/providers/commandcode/instructions", {
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
      const seed = json.mode === "custom"
        ? (json.customContent || "")
        : json.defaultContent;
      setDraft(seed);
      lastLoadedDraftRef.current = seed;
      setDraftMode(json.mode || "default");
      setInfo(next
        ? "Command Code default instructions enabled."
        : "Command Code default instructions disabled."
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
      const res = await fetch("/api/providers/commandcode/instructions", {
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
    if (!confirm("Reset to built-in Command Code default instructions? Any custom content will be deleted.")) return;
    setSaving(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/providers/commandcode/instructions", {
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
    return <Card><div className="py-6 text-sm text-text-muted">Loading Command Code default instructions…</div></Card>;
  }

  if (!data) {
    return <Card><div className="py-6 text-sm text-red-500">{error || "Failed to load Command Code instructions settings"}</div></Card>;
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-lg font-semibold">Command Code Default Instructions</h2>
          <p className="text-sm text-text-muted mt-1">
            Controls the default coding-agent behavior sent to Command Code requests.
            Default mode sends the built-in agent prompt, custom mode sends your own
            <code className="font-mono"> commandcode-instructions.md </code>
            content, and disabled sends no default provider instructions.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-sm text-text-muted">{data.enabled ? "Enabled" : "Disabled"}</span>
          <Toggle checked={data.enabled} onChange={(v) => onToggleEnabled(v)} disabled={saving} />
        </div>
      </div>

      {error && <p className="text-xs text-red-500 mb-3 break-words">{error}</p>}
      {info && !error && <p className="text-xs text-green-500 mb-3 break-words">{info}</p>}

      {!data.enabled ? (
        <div className="rounded border border-border p-3 text-sm text-text-muted bg-bg-subtle">
          Sending no default Command Code instructions. Use this only if you want the
          raw upstream model behavior without the coding-agent guardrails.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-sm">
              Mode: <span className="font-medium">{data.mode === "custom" ? "Custom (.md file)" : "Built-in default"}</span>
              {data.mode === "custom" && data.hasCustomFile && (
                <span className="text-text-muted ml-2">
                  - {data.customLength.toLocaleString()} chars in <code className="font-mono">{data.filename}</code>
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {data.mode === "default" && (
                <Button size="sm" variant="secondary" onClick={onLoadDefaultIntoEditor} disabled={saving}>Edit as custom</Button>
              )}
              {data.mode === "custom" && (
                <Button size="sm" variant="secondary" onClick={onResetToDefault} disabled={saving}>Reset to default</Button>
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
            rows={18}
            className="w-full font-mono text-xs rounded border border-border bg-bg-input p-3 leading-relaxed"
            placeholder="Write your custom Command Code instructions here…"
          />

          <div className="rounded border border-border p-3 text-xs text-text-muted bg-bg-subtle">
            Recommended for most users: keep <span className="font-medium">Built-in default</span> enabled.
            Switch to <span className="font-medium">Custom</span> only when you want to override
            the provider's default coding-agent behavior for every Command Code request.
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap text-xs text-text-muted">
            <span>{draft.length.toLocaleString()} chars</span>
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
                Revert
              </Button>
              <Button size="sm" onClick={onSaveCustom} disabled={saving || draftMode !== "custom" || !dirty}>
                Save custom
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
