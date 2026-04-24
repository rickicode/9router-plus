"use client";

import { useMemo, useState } from "react";
import { Button, Card } from "@/shared/components";
import OpenCodeModelSelectModal from "./OpenCodeModelSelectModal";

const ASSIGNMENT_PRESET_OPTIONS = [
  { value: "", label: "Apply preset..." },
  { value: "balanced", label: "Balanced" },
  { value: "reasoning-heavy", label: "Reasoning heavy" },
  { value: "speed-heavy", label: "Speed heavy" },
];

const MANAGED_OVERRIDE_KEYS = new Set([
  "preset",
  "agentAssignments",
  "categoryAssignments",
  "lspServers",
]);

const OPENAGENT_AGENT_ROWS = [
  { id: "explorer", label: "explorer", note: "Fast exploration" },
  { id: "sisyphus", label: "sisyphus", note: "Master orchestrator" },
  { id: "oracle", label: "oracle", note: "Strategic advisor" },
  { id: "librarian", label: "librarian", note: "Research" },
  { id: "prometheus", label: "prometheus", note: "Planner" },
  { id: "atlas", label: "atlas", note: "Execution orchestrator" },
];

const OPENAGENT_CATEGORY_ROWS = [
  { id: "deep", label: "deep", note: "Deep problem solving" },
  { id: "quick", label: "quick", note: "Trivial tasks" },
  { id: "visual-engineering", label: "visual-engineering", note: "UI work" },
  { id: "writing", label: "writing", note: "Documentation" },
  { id: "artistry", label: "artistry", note: "Creative work" },
];

const SLIM_AGENT_ROWS = [
  { id: "core", label: "core", note: "Default slim worker" },
  { id: "research", label: "research", note: "Research + docs" },
  { id: "execution", label: "execution", note: "Fast implementation" },
];

const SLIM_CATEGORY_ROWS = [
  { id: "default", label: "default", note: "General traffic" },
  { id: "long-context", label: "long-context", note: "Context-heavy" },
  { id: "low-latency", label: "low-latency", note: "Latency-sensitive" },
];

const PUBLIC_ARTIFACTS_COPY = "Only server-provided public artifacts appear here.";

function getMissingVariantArtifactCopy(variant) {
  if (variant === "custom") {
    return `${PUBLIC_ARTIFACTS_COPY} Custom variant does not publish a generated advanced file here. Use the editor for manual overrides only.`;
  }

  return `${PUBLIC_ARTIFACTS_COPY} No generated advanced artifact is available right now. You can still edit overrides below.`;
}

function buildDefaultDraft(variant) {
  return {
    preset: "",
    agentAssignments: {},
    categoryAssignments: {},
    lspServers: [],
    raw: {},
    variant,
  };
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
}

function normalizeDraft(variant, source) {
  const base = buildDefaultDraft(variant);
  const next = source && typeof source === "object" ? source : {};
  return {
    ...base,
    ...next,
    variant,
    agentAssignments:
      next.agentAssignments && typeof next.agentAssignments === "object" && !Array.isArray(next.agentAssignments)
        ? next.agentAssignments
        : {},
    categoryAssignments:
      next.categoryAssignments && typeof next.categoryAssignments === "object" && !Array.isArray(next.categoryAssignments)
        ? next.categoryAssignments
        : {},
    lspServers: Array.isArray(next.lspServers) ? next.lspServers : [],
    raw: cloneValue(next),
  };
}

function getManagedOverridePayload(draft) {
  const payload = {};

  if (draft.preset) {
    payload.preset = draft.preset;
  }

  if (draft.agentAssignments && Object.keys(draft.agentAssignments).length > 0) {
    payload.agentAssignments = draft.agentAssignments;
  }

  if (draft.categoryAssignments && Object.keys(draft.categoryAssignments).length > 0) {
    payload.categoryAssignments = draft.categoryAssignments;
  }

  const normalizedLspServers = (draft.lspServers || []).filter((server) =>
    server.language || server.command || server.args
  );

  if (normalizedLspServers.length > 0) {
    payload.lspServers = normalizedLspServers;
  }

  return payload;
}

function mergePreservingUnknownFields(raw, structuredDraft) {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? cloneValue(raw) : {};
  for (const key of MANAGED_OVERRIDE_KEYS) {
    delete base[key];
  }
  return {
    ...base,
    ...getManagedOverridePayload(structuredDraft),
  };
}

function getPresetModels(modelOptions) {
  const usableModels = Array.isArray(modelOptions) ? modelOptions.filter(Boolean) : [];
  return {
    primary: usableModels[0] || "",
    secondary: usableModels[1] || usableModels[0] || "",
    tertiary: usableModels[2] || usableModels[1] || usableModels[0] || "",
  };
}

function buildPresetAssignments(variant, preset, modelOptions) {
  const { primary, secondary, tertiary } = getPresetModels(modelOptions);
  if (!preset) {
    return {
      preset: "",
      agentAssignments: {},
      categoryAssignments: {},
    };
  }

  const compactAssignments = (assignments) =>
    Object.fromEntries(Object.entries(assignments).filter(([, value]) => Boolean(value)));

  const buildPresetPayload = ({ preset: nextPreset, agentAssignments, categoryAssignments }) => ({
    preset: nextPreset,
    agentAssignments: compactAssignments(agentAssignments),
    categoryAssignments: compactAssignments(categoryAssignments),
  });

  if (variant === "slim") {
    if (preset === "reasoning-heavy") {
      return buildPresetPayload({
        preset,
        agentAssignments: {
          core: primary,
          research: primary,
          execution: secondary,
        },
        categoryAssignments: {
          default: primary,
          "long-context": primary,
          "low-latency": secondary,
        },
      });
    }

    if (preset === "speed-heavy") {
      return buildPresetPayload({
        preset,
        agentAssignments: {
          core: secondary,
          research: primary,
          execution: secondary,
        },
        categoryAssignments: {
          default: secondary,
          "long-context": primary,
          "low-latency": secondary,
        },
      });
    }

    return buildPresetPayload({
      preset,
      agentAssignments: {
        core: primary,
        research: secondary,
        execution: secondary,
      },
      categoryAssignments: {
        default: primary,
        "long-context": primary,
        "low-latency": secondary,
      },
    });
  }

  if (preset === "reasoning-heavy") {
    return buildPresetPayload({
      preset,
      agentAssignments: {
        explorer: secondary,
        sisyphus: primary,
        oracle: primary,
        librarian: primary,
        prometheus: primary,
        atlas: secondary,
      },
      categoryAssignments: {
        deep: primary,
        quick: secondary,
        "visual-engineering": secondary,
        writing: primary,
        artistry: tertiary,
      },
    });
  }

  if (preset === "speed-heavy") {
    return buildPresetPayload({
      preset,
      agentAssignments: {
        explorer: secondary,
        sisyphus: primary,
        oracle: primary,
        librarian: secondary,
        prometheus: secondary,
        atlas: secondary,
      },
      categoryAssignments: {
        deep: primary,
        quick: secondary,
        "visual-engineering": secondary,
        writing: secondary,
        artistry: tertiary,
      },
    });
  }

  return buildPresetPayload({
    preset,
    agentAssignments: {
      explorer: secondary,
      sisyphus: primary,
      oracle: primary,
      librarian: secondary,
      prometheus: primary,
      atlas: secondary,
    },
    categoryAssignments: {
      deep: primary,
      quick: secondary,
      "visual-engineering": secondary,
      writing: primary,
      artistry: tertiary,
    },
  });
}

function getVariantRows(variant) {
  if (variant === "slim") {
    return { agentRows: SLIM_AGENT_ROWS, categoryRows: SLIM_CATEGORY_ROWS };
  }

  return { agentRows: OPENAGENT_AGENT_ROWS, categoryRows: OPENAGENT_CATEGORY_ROWS };
}

function getConfigTitle(variant) {
  if (variant === "slim") return "Advanced config: Oh My OpenCode Slim";
  if (variant === "openagent") return "Advanced config: Oh My Open Agent";
  return "Advanced overrides";
}

function getCardSubtitle(variant, hasGeneratedArtifact, configFilename) {
  if (variant === "custom") {
    return "Custom uses manual overrides only. No public generated variant artifact is exposed here.";
  }

  if (hasGeneratedArtifact) {
    return `Selected variant extras live here as ${configFilename}.`;
  }

  return `${PUBLIC_ARTIFACTS_COPY} Use the editor below to manage overrides.`;
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function downloadTextFile(content, filename) {
  if (typeof window === "undefined") return;

  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function AdvancedOverridesCard({
  preferences,
  generatedArtifact = null,
  modelOptions = [],
  activeProviders = [],
  modelAliases = {},
  saving = false,
  error = "",
  onSave,
}) {
  const variant = preferences?.variant || "openagent";
  const currentOverrides = useMemo(
    () => preferences?.advancedOverrides?.[variant] || {},
    [preferences?.advancedOverrides, variant]
  );
  const generatedArtifactMeta = useMemo(() => {
    const filename = typeof generatedArtifact?.filename === "string" && generatedArtifact.filename.trim()
      ? generatedArtifact.filename
      : null;
    const content =
      generatedArtifact?.content && typeof generatedArtifact.content === "object" && !Array.isArray(generatedArtifact.content)
        ? generatedArtifact.content
        : null;

    if (!filename || !content) {
      return { filename: null, content: null, available: false };
    }

    return { filename, content, available: true };
  }, [generatedArtifact]);
  const configFilename = generatedArtifactMeta.filename;
  const generatedVariantConfig = useMemo(
    () => generatedArtifactMeta.content,
    [generatedArtifactMeta]
  );
  const hasGeneratedArtifact = generatedArtifactMeta.available;
  const { agentRows, categoryRows } = useMemo(() => getVariantRows(variant), [variant]);
  const initialDraft = useMemo(
    () => normalizeDraft(variant, currentOverrides),
    [currentOverrides, variant]
  );
  const initialRawValue = useMemo(
    () => JSON.stringify(currentOverrides, null, 2),
    [currentOverrides]
  );
  const [draft, setDraft] = useState(initialDraft);
  const [rawValue, setRawValue] = useState(initialRawValue);
  const [parseError, setParseError] = useState("");
  const [collapsed, setCollapsed] = useState(true);
  const [showRawEditor, setShowRawEditor] = useState(variant === "custom");
  const [activePicker, setActivePicker] = useState(null);

  const availableModelOptions = useMemo(
    () => Array.from(new Set((modelOptions || []).filter(Boolean))).sort((left, right) => left.localeCompare(right)),
    [modelOptions]
  );

  const updateAssignment = (section, key, value) => {
    setDraft((previous) => ({
      ...previous,
      [section]: {
        ...(previous[section] || {}),
        [key]: value,
      },
    }));
  };

  const clearAssignment = (section, key) => {
    setDraft((previous) => {
      const nextSection = { ...(previous[section] || {}) };
      delete nextSection[key];
      return {
        ...previous,
        [section]: nextSection,
      };
    });
  };

  const applyPreset = (preset) => {
    const nextPreset = buildPresetAssignments(variant, preset, modelOptions);
    if (!nextPreset) {
      setDraft((previous) => ({
        ...previous,
        preset: "",
      }));
      return;
    }

    setDraft((previous) => ({
      ...previous,
      preset: nextPreset.preset,
      agentAssignments: nextPreset.agentAssignments,
      categoryAssignments: nextPreset.categoryAssignments,
    }));
  };

  const addLspServer = () => {
    setDraft((previous) => ({
      ...previous,
      lspServers: [...(previous.lspServers || []), { language: "", command: "", args: "" }],
    }));
  };

  const updateLspServer = (index, key, value) => {
    setDraft((previous) => ({
      ...previous,
      lspServers: (previous.lspServers || []).map((server, serverIndex) =>
        serverIndex === index ? { ...server, [key]: value } : server
      ),
    }));
  };

  const removeLspServer = (index) => {
    setDraft((previous) => ({
      ...previous,
      lspServers: (previous.lspServers || []).filter((_, serverIndex) => serverIndex !== index),
    }));
  };

  const parseRawOverrides = (value) => {
    const parsed = value.trim() ? JSON.parse(value) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Overrides must be a JSON object");
    }
    return parsed;
  };

  const handleSave = async () => {
    try {
      let parsedFromRaw = {};

      if (showRawEditor) {
        parsedFromRaw = parseRawOverrides(rawValue);
      }

      const nextOverrides = showRawEditor
        ? parsedFromRaw
        : mergePreservingUnknownFields(draft.raw, draft);

      setParseError("");
      await onSave?.({
        advancedOverrides: {
          ...(preferences?.advancedOverrides || {}),
          [variant]: nextOverrides,
        },
      });
      setCollapsed(true);
    } catch (saveError) {
      setParseError(saveError.message || "Failed to save overrides");
    }
  };

  const openAssignmentPicker = (section, key, label) => {
    setActivePicker({ section, key, label });
  };

  const toggleRawEditor = () => {
    if (showRawEditor) {
      try {
        const parsedFromRaw = parseRawOverrides(rawValue);
        setDraft(normalizeDraft(variant, parsedFromRaw));
        setRawValue(prettyJson(parsedFromRaw));
        setParseError("");
        setShowRawEditor(false);
      } catch (parseToggleError) {
        setParseError(parseToggleError.message || "Invalid JSON overrides");
      }
      return;
    }

    setRawValue(prettyJson(mergePreservingUnknownFields(draft.raw, draft)));
    setParseError("");
    setShowRawEditor(true);
  };

  const currentPickerValue = activePicker ? draft?.[activePicker.section]?.[activePicker.key] || "" : "";

  return (
    <Card
      title={getConfigTitle(variant)}
      subtitle={getCardSubtitle(variant, hasGeneratedArtifact, configFilename)}
      icon="settings"
      className="rounded border-border"
      action={
        <div className="flex flex-wrap items-center gap-2">
          {hasGeneratedArtifact ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => downloadTextFile(prettyJson(generatedVariantConfig), configFilename)}
            >
              Download {configFilename}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => setCollapsed((value) => !value)}>
            {collapsed ? "Show editor" : "Hide editor"}
          </Button>
        </div>
      }
    >
      {collapsed ? (
        <div className="space-y-6">
          {hasGeneratedArtifact ? (
            <div className="rounded border border-primary/10 bg-[var(--color-primary-soft)] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-text-main">{configFilename}</p>
                  <p className="mt-1 text-xs text-text-muted">
                    Generated advanced config for the selected variant. Keep it below the main opencode.json flow.
                  </p>
                </div>
                <span className="material-symbols-outlined text-[18px] text-primary">tune</span>
              </div>
              <pre className="mt-4 max-h-[18rem] overflow-auto rounded border border-border bg-[var(--color-editor-bg)] px-4 py-4 text-xs leading-6 text-[var(--color-text-inverse)]">
                <code>{prettyJson(generatedVariantConfig)}</code>
              </pre>
            </div>
          ) : (
            <div className="rounded border border-dashed border-border bg-[var(--color-bg-alt)] p-4 text-sm text-text-muted">
              {getMissingVariantArtifactCopy(variant)}
            </div>
          )}
          <p className="text-sm text-text-muted">
            Expand only if you need to change overrides, assignments, LSP servers, or raw JSON.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {error ? <p className="text-sm text-[var(--color-danger)]">{error}</p> : null}
          {parseError ? <p className="text-sm text-[var(--color-danger)]">{parseError}</p> : null}

          {hasGeneratedArtifact ? (
            <div className="rounded border border-border bg-[var(--color-surface)] px-5 py-5">
              <div className="space-y-1.5">
                <p className="text-sm font-semibold text-text-main">Generated output</p>
                <p className="text-xs leading-5 text-text-muted">Preview of the current generated advanced file for this variant.</p>
              </div>
              <pre className="mt-4 max-h-[18rem] overflow-auto rounded border border-border bg-[var(--color-editor-bg)] px-4 py-4 text-xs leading-6 text-[var(--color-text-inverse)]">
                <code>{prettyJson(generatedVariantConfig)}</code>
              </pre>
            </div>
          ) : null}

          <div className="rounded border border-border bg-[var(--color-surface)] px-5 py-5">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="space-y-1.5">
                <p className="text-sm font-semibold text-text-main">Assignment controls</p>
                <p className="text-xs leading-5 text-text-muted">Use a preset as a starting point, then refine assignments and supporting servers below.</p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="text-sm font-medium text-text-main" htmlFor={`preset-${variant}`}>
                    Preset
                  </label>
                  <select
                    id={`preset-${variant}`}
                    value={draft.preset || ""}
                    onChange={(event) => applyPreset(event.target.value)}
                    className="h-10 rounded border border-border bg-[var(--color-surface)] px-3 text-sm text-text-main"
                    disabled={variant === "custom"}
                  >
                    {ASSIGNMENT_PRESET_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <Button variant="ghost" size="sm" onClick={toggleRawEditor}>
                  {showRawEditor ? "Hide raw JSON" : "Show raw JSON"}
                </Button>
              </div>
            </div>
          </div>

          {variant === "custom" ? (
            <div className="rounded border border-[var(--color-warning)]/20 bg-[var(--color-warning-soft)] px-4 py-3 text-sm text-[var(--color-warning)]">
              Custom / No preset uses raw JSON overrides instead of the preset matrix.
            </div>
          ) : null}

          {variant !== "custom" ? (
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-4 rounded border border-border bg-[var(--color-surface)] px-5 py-5">
                <div className="space-y-1">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Agent assignments</h4>
                  <p className="text-xs leading-5 text-text-muted">Map each agent with enough breathing room to compare selections comfortably.</p>
                </div>
                {agentRows.map((row) => (
                  <div key={row.id} className="rounded border border-border px-4 py-3.5">
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                      <div>
                        <p className="text-sm font-medium text-text-main">{row.label}</p>
                        <p className="mt-1 text-xs text-text-muted">{row.note}</p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="min-w-[220px] justify-between"
                        onClick={() => openAssignmentPicker("agentAssignments", row.id, row.label)}
                      >
                        <span className="truncate">{draft.agentAssignments?.[row.id] || "Use default"}</span>
                        <span className="material-symbols-outlined text-[16px]">unfold_more</span>
                      </Button>
                      {draft.agentAssignments?.[row.id] ? (
                        <Button variant="ghost" size="sm" onClick={() => clearAssignment("agentAssignments", row.id)}>
                          Use default
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>

              <div className="space-y-4 rounded border border-border bg-[var(--color-surface)] px-5 py-5">
                <div className="space-y-1">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Category assignments</h4>
                  <p className="text-xs leading-5 text-text-muted">Keep routing separate from agent mapping so the advanced matrix is easier to scan.</p>
                </div>
                {categoryRows.map((row) => (
                  <div key={row.id} className="rounded border border-border px-4 py-3.5">
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                      <div>
                        <p className="text-sm font-medium text-text-main">{row.label}</p>
                        <p className="mt-1 text-xs text-text-muted">{row.note}</p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="min-w-[220px] justify-between"
                        onClick={() => openAssignmentPicker("categoryAssignments", row.id, row.label)}
                      >
                        <span className="truncate">{draft.categoryAssignments?.[row.id] || "Use default"}</span>
                        <span className="material-symbols-outlined text-[16px]">unfold_more</span>
                      </Button>
                      {draft.categoryAssignments?.[row.id] ? (
                        <Button variant="ghost" size="sm" onClick={() => clearAssignment("categoryAssignments", row.id)}>
                          Use default
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="space-y-4 rounded border border-[var(--color-success)]/20 bg-[var(--color-success-soft)] px-5 py-5">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-success)]">LSP Servers</h4>
                <p className="text-xs leading-5 text-text-muted">Add optional language server entries without crowding the assignments above.</p>
              </div>
              <Button variant="ghost" size="sm" onClick={addLspServer}>Add row</Button>
            </div>

            {(draft.lspServers || []).length === 0 ? (
              <p className="text-sm text-text-muted">No LSP servers configured.</p>
            ) : (
              <div className="space-y-3">
                {(draft.lspServers || []).map((server, index) => (
                  <div key={`${server.language || "lang"}-${index}`} className="grid gap-3 rounded border border-[var(--color-success)]/20 bg-[var(--color-surface)] p-4 md:grid-cols-[140px_1fr_1fr_auto]">
                    <input
                      value={server.language || ""}
                      onChange={(event) => updateLspServer(index, "language", event.target.value)}
                      placeholder="language"
                      className="h-9 rounded border border-border bg-[var(--color-surface)] px-3 text-xs text-text-main"
                    />
                    <input
                      value={server.command || ""}
                      onChange={(event) => updateLspServer(index, "command", event.target.value)}
                      placeholder="command"
                      className="h-9 rounded border border-border bg-[var(--color-surface)] px-3 text-xs text-text-main"
                    />
                    <input
                      value={server.args || ""}
                      onChange={(event) => updateLspServer(index, "args", event.target.value)}
                      placeholder="args"
                      className="h-9 rounded border border-border bg-[var(--color-surface)] px-3 text-xs text-text-main"
                    />
                    <Button variant="ghost" size="sm" onClick={() => removeLspServer(index)}>Remove</Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {showRawEditor ? (
            <textarea
              value={rawValue}
              onChange={(event) => setRawValue(event.target.value)}
              className="min-h-[260px] w-full rounded border border-border bg-[var(--color-surface)] px-4 py-4 font-mono text-sm text-text-main outline-none transition-all focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
              spellCheck={false}
            />
          ) : null}

          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={handleSave} loading={saving}>
              Save overrides
            </Button>
          </div>
        </div>
      )}

      <OpenCodeModelSelectModal
        isOpen={Boolean(activePicker)}
        onClose={() => setActivePicker(null)}
        onSelect={(selection) => {
          if (!activePicker) return;
          const nextValue = selection?.value;
          if (!nextValue || !availableModelOptions.includes(nextValue)) return;
          updateAssignment(activePicker.section, activePicker.key, nextValue);
        }}
        selectedModel={currentPickerValue}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        title={activePicker ? `Assign model · ${activePicker.label}` : "Assign model"}
      />
    </Card>
  );
}
