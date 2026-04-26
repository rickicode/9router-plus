"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sanitizeSensitiveConfig } from "@/lib/opencodeSync/schema";
import { Badge, Button, Card, CardSkeleton, Input, Select, Toggle, ModelSelectModal } from "@/shared/components";
import { cn } from "@/shared/utils/cn";
import AdvancedConfigEditor from "./components/AdvancedConfigEditor";
import TokenManagerCard from "./components/TokenManagerCard";

/* ── constants ─────────────────────────────────────────────────── */

const PLUGIN_SYNC = "opencode-9router-sync@latest";
const PLUGIN_OPENAGENT = "oh-my-openagent@latest";
const PLUGIN_SLIM = "oh-my-opencode-slim@latest";

const DEFAULT_PLUGINS = [PLUGIN_SYNC, PLUGIN_OPENAGENT];

/* ── helpers ───────────────────────────────────────────────────── */

function getErrorMessage(error, fallback) {
  return error?.message || fallback;
}

function prettyJson(value) {
  try {
    if (value === null || value === undefined) return "{}";
    return JSON.stringify(value, null, 2);
  } catch (err) {
    console.error("Error stringifying JSON:", err);
    return "{}";
  }
}

function downloadFile(content, filename) {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ── sub-components ────────────────────────────────────────────── */

function ModelSelector({ preferences, modelCatalog, saving, onSave, activeProviders, modelAliases }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const mode = preferences?.modelSelectionMode || "exclude";
  const listKey = mode === "include" ? "includedModels" : "excludedModels";
  const selectedModels = useMemo(() => preferences?.[listKey] || [], [preferences, listKey]);

  const availableOptions = useMemo(() => {
    const catalog = Array.isArray(modelCatalog) ? modelCatalog.map((m) => m.id).filter(Boolean) : [];
    return Array.from(new Set(catalog))
      .filter((id) => !selectedModels.includes(id))
      .sort((a, b) => a.localeCompare(b));
  }, [modelCatalog, selectedModels]);

  const addModels = (selections) => {
    const modelIds = Array.isArray(selections) 
      ? selections.map(s => s?.value).filter(Boolean)
      : [selections?.value].filter(Boolean);
    const newModels = modelIds.filter(id => !selectedModels.includes(id));
    if (newModels.length === 0) return;
    onSave?.({ [listKey]: [...selectedModels, ...newModels] });
  };

  const removeModel = (modelId) => {
    onSave?.({ [listKey]: selectedModels.filter((id) => id !== modelId) });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
          Model selection
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onSave?.({ modelSelectionMode: "exclude" })}
            className={cn(
              "rounded border px-3 py-1.5 text-[14px] font-medium transition-colors cursor-pointer",
              mode === "exclude"
                ? "border-[var(--color-primary)]/30 bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                : "border-[var(--color-border)] bg-[var(--color-bg-alt)] text-[var(--color-text-muted)] hover:text-[var(--color-text-main)]"
            )}
          >
            Exclude from catalog
          </button>
          <button
            type="button"
            onClick={() => onSave?.({ modelSelectionMode: "include" })}
            className={cn(
              "rounded border px-3 py-1.5 text-[14px] font-medium transition-colors cursor-pointer",
              mode === "include"
                ? "border-[var(--color-primary)]/30 bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                : "border-[var(--color-border)] bg-[var(--color-bg-alt)] text-[var(--color-text-muted)] hover:text-[var(--color-text-main)]"
            )}
          >
            Include only
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-3">
        {selectedModels.length === 0 ? (
          <p className="text-[14px] text-[var(--color-text-muted)]">
            {mode === "include"
              ? "No included models selected yet."
              : "No excluded models. Full catalog will be used."}
          </p>
        ) : (
          selectedModels.map((modelId) => (
            <span key={modelId} className="flex items-center gap-1.5 pr-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[14px] text-[var(--color-text-main)]">
              <span className="max-w-[200px] truncate">{modelId}</span>
              <button
                type="button"
                className="rounded-full p-0.5 hover:text-[var(--color-danger)] cursor-pointer"
                onClick={() => removeModel(modelId)}
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            </span>
          ))
        )}
        <button
          className="rounded bg-transparent px-[12px] py-[4px] text-[14px] font-medium leading-[2.00] text-[var(--color-text-main)] hover:bg-[var(--color-surface)] transition-colors border border-transparent hover:border-[var(--color-border)] cursor-pointer disabled:opacity-50"
          onClick={() => setPickerOpen(true)}
          disabled={availableOptions.length === 0 || saving}
        >
          {mode === "include" ? "+ Add model" : "+ Exclude model"}
        </button>
      </div>

      <ModelSelectModal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={addModels}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        title={mode === "include" ? "Add allowed models" : "Add excluded models"}
      />
    </div>
  );
}

function VariantToggle({ variant, onVariantChange }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
        Variant
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onVariantChange("openagent")}
          className={cn(
            "flex-1 rounded border px-3 py-2 text-[14px] font-medium transition-colors cursor-pointer text-left",
            variant === "openagent"
              ? "border-[var(--color-primary)] bg-[var(--color-bg-alt)] text-[var(--color-text-main)]"
              : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] hover:border-[var(--color-primary)]/50"
          )}
        >
          <div className="font-bold">Oh My Open Agent</div>
          <div className="mt-0.5 text-[12px] opacity-70">Recommended · Full preset</div>
        </button>
        <button
          type="button"
          onClick={() => onVariantChange("slim")}
          className={cn(
            "flex-1 rounded border px-3 py-2 text-[14px] font-medium transition-colors cursor-pointer text-left",
            variant === "slim"
              ? "border-[var(--color-primary)] bg-[var(--color-bg-alt)] text-[var(--color-text-main)]"
              : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] hover:border-[var(--color-primary)]/50"
          )}
        >
          <div className="font-bold">Oh My OpenCode Slim</div>
          <div className="mt-0.5 text-[12px] opacity-70">Lighter preset</div>
        </button>
        <button
          type="button"
          onClick={() => onVariantChange("custom")}
          className={cn(
            "flex-1 rounded border px-3 py-2 text-[14px] font-medium transition-colors cursor-pointer text-left",
            variant === "custom"
              ? "border-[var(--color-primary)] bg-[var(--color-bg-alt)] text-[var(--color-text-main)]"
              : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] hover:border-[var(--color-primary)]/50"
          )}
        >
          <div className="font-bold">Custom / No preset</div>
          <div className="mt-0.5 text-[12px] opacity-70">Manual overrides only</div>
        </button>
      </div>
    </div>
  );
}

function PluginSection({ plugins, pluginInput, onPluginInputChange, onAddPlugin, onRemovePlugin }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
        Plugins
      </p>
      <div className="flex flex-wrap gap-2">
        {plugins.map((plugin) => (
          <div
            key={plugin}
            className="inline-flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-2.5 py-1 text-[14px] text-[var(--color-text-main)]"
          >
            <span className="material-symbols-outlined text-[14px] text-[var(--color-primary)]">extension</span>
            {plugin}
            {!DEFAULT_PLUGINS.includes(plugin) && (
              <button
                type="button"
                onClick={() => onRemovePlugin(plugin)}
                className="ml-0.5 rounded-full p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-danger)] cursor-pointer"
                title="Remove plugin"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onAddPlugin();
          }}
        >
          <Input
            value={pluginInput}
            onChange={(e) => onPluginInputChange(e.target.value)}
            placeholder="e.g. opencode-plugin-name"
            className="flex-1"
          />
          <Button type="submit" variant="secondary" size="sm" disabled={!pluginInput.trim()}>
            Add Plugin
          </Button>
        </form>
      </div>
    </div>
  );
}

function McpSection({ mcps, onAddMcp, onRemoveMcp, onToggleMcpEnabled }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("local");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");

  const handleAdd = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    if (mcps.some((m) => m.name === trimmedName)) return;

    if (type === "remote") {
      if (!url.trim()) return;
      onAddMcp({ name: trimmedName, type: "remote", url: url.trim() });
      setUrl("");
    } else {
      if (!command.trim()) return;
      onAddMcp({ name: trimmedName, type: "local", command: command.trim() });
      setCommand("");
    }
    setName("");
  };

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
        MCP Servers
      </p>
      {mcps.length > 0 && (
        <div className="space-y-1.5">
          {mcps.map((mcp, idx) => (
            <div
              key={`${mcp.name}-${idx}`}
              className="flex items-center justify-between gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2 text-[var(--color-text-main)]"
            >
              <div className="flex items-center gap-2 text-[14px]">
                <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">dns</span>
                <span className="font-bold text-[var(--color-text-main)]">{mcp.name}</span>
                <span className="text-[var(--color-text-muted)] ml-2">{mcp.type}</span>
              </div>
              <div className="flex items-center gap-1">
                <Toggle
                  checked={mcp.disabled !== true}
                  onChange={() => onToggleMcpEnabled(mcp.name)}
                />
                <button
                  type="button"
                  onClick={() => onRemoveMcp(mcp.name)}
                  className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] cursor-pointer transition-colors"
                  title="Remove MCP server"
                >
                  <span className="material-symbols-outlined text-[16px]">close</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <form
        className="grid gap-2 sm:grid-cols-[1fr_auto_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          onAddMcp({ name, type, command, url });
          setName("");
          setCommand("");
          setUrl("");
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Server Name"
        />
        <Select
          value={type}
          onChange={(e) => setType(e.target.value)}
          options={[
            { value: "local", label: "Local Command" },
            { value: "sse", label: "SSE URL" },
          ]}
        />
        
        {type === "local" ? (
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="npx -y some-mcp-server"
          />
        ) : (
          <Input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:8080/sse"
          />
        )}
        <Button 
          type="submit" 
          variant="secondary"
          size="sm"
          disabled={!name.trim() || (type === "local" ? !command.trim() : !url.trim())}
        >
          Add MCP
        </Button>
      </form>
    </div>
  );
}

function EnvVarsSection({ envVars, onAddEnvVar, onRemoveEnvVar }) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [secret, setSecret] = useState(false);

  const handleAdd = () => {
    if (!key.trim()) return;
    onAddEnvVar({ key: key.trim(), value, secret });
    setKey("");
    setValue("");
    setSecret(false);
  };

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
        Environment Variables
      </p>
      {envVars.length > 0 && (
        <div className="space-y-1.5">
          {envVars.map((env, idx) => (
            <div
              key={`${env.key}-${idx}`}
              className="flex items-center justify-between gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2 text-[var(--color-text-main)]"
            >
              <div className="flex items-center gap-2 text-[14px]">
                <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">key</span>
                <span className="font-bold text-[var(--color-text-main)]">{env.key}</span>
                <span className="text-[var(--color-text-muted)] ml-2 truncate max-w-[200px]">
                  {env.secret ? "••••••••" : env.value}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onRemoveEnvVar(env.key)}
                className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] cursor-pointer transition-colors"
                title="Remove environment variable"
              >
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>
          ))}
        </div>
      )}
      <form
        className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          onAddEnvVar({ key, value, secret });
          setKey("");
          setValue("");
          setSecret(false);
        }}
      >
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="VARIABLE_NAME"
        />
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Value"
        />
        <label className="flex items-center gap-1.5 text-sm text-[var(--color-text-muted)] cursor-pointer pl-2">
          <input
            type="checkbox"
            checked={secret}
            onChange={(e) => setSecret(e.target.checked)}
            className="rounded border-[var(--color-border)] text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
          />
          Secret
        </label>
        <Button 
          type="submit" 
          variant="secondary"
          size="sm"
          disabled={!key.trim() || !value.trim()}
        >
          Add Var
        </Button>
      </form>
    </div>
  );
}

function ConfigPreview({ preview, variant, loading, error, onRefresh, selectedApiKey, requireApiKey }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  let safePreview = null;
  let opencodeConfig = null;
  let configJson = "";
  
  try {
    safePreview = sanitizeSensitiveConfig(preview || null);
    opencodeConfig = safePreview?.opencode || null;
    
    // Replace API key in config
    if (opencodeConfig && opencodeConfig.provider?.["9router"]) {
      opencodeConfig = {
        ...opencodeConfig,
        provider: {
          ...opencodeConfig.provider,
          "9router": {
            ...opencodeConfig.provider["9router"],
            options: {
              ...opencodeConfig.provider["9router"].options,
              apiKey: requireApiKey && selectedApiKey ? selectedApiKey : "sk_9router",
            },
          },
        },
      };
    }
    
    configJson = opencodeConfig ? prettyJson(opencodeConfig) : "";
  } catch (err) {
    console.error("Error processing config preview:", err);
    opencodeConfig = null;
    configJson = "";
  }

  const variantArtifact = useMemo(() => {
    try {
      if (variant === "openagent" && safePreview?.ohMyOpencode) {
        return { filename: "oh-my-openagent.json", content: safePreview.ohMyOpencode };
      }
      if (variant === "slim" && safePreview?.ohMyOpenCodeSlim) {
        return { filename: "oh-my-opencode-slim.json", content: safePreview.ohMyOpenCodeSlim };
      }
    } catch (err) {
      console.error("Error processing variant artifact in ConfigPreview:", err);
    }
    return null;
  }, [variant, safePreview]);

  const handleCopy = async (text) => {
    if (!navigator?.clipboard) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  if (loading) {
    return (
      <div className="space-y-3 text-[var(--color-text-main)]">
        <div className="flex items-start gap-3 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-3">
          <p className="text-[14px] text-[var(--color-text-muted)] leading-[1.50]">
            The opencode.json config file uses the OpenCode schema.
            <code className="rounded bg-[var(--color-surface)] px-1.5 py-0.5 font-bold text-[12px] text-[var(--color-primary)] ml-1">
              opencode-9router-sync
            </code>
            is included automatically.
          </p>
        </div>

        <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-alt)] px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">data_object</span>
              <span className="text-[14px] font-bold text-[var(--color-text-main)]">opencode.json</span>
            </div>
            <div className="flex items-center gap-2">
              {requireApiKey && (
                <span className="flex items-center gap-1 rounded border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-2 py-0.5 text-[12px] text-[var(--color-warning)]">
                  <span className="material-symbols-outlined text-[12px]">key</span>
                  Requires valid API key
                </span>
              )}
              <Button variant="ghost" size="sm" icon="download" disabled>
                Download
              </Button>
              <Button variant="ghost" size="sm" icon="content_copy" disabled>
                Copy
              </Button>
            </div>
          </div>
          <pre className="max-h-[32rem] overflow-auto bg-[var(--color-surface)] px-4 py-4 text-[13px] leading-[1.60] text-[var(--color-text-main)] custom-scrollbar">
            <code>Loading...</code>
          </pre>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/10 px-4 py-3 text-[14px] text-[var(--color-danger)]">
        {error}
        <Button variant="ghost" size="sm" className="ml-2" onClick={onRefresh}>
          Retry
        </Button>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-4 py-6 text-center text-[14px] text-[var(--color-text-muted)]">
        Preview not available
        <Button variant="secondary" size="sm" className="ml-2" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
    );
  }

  if (!opencodeConfig) {
    return (
      <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-4 py-6 text-center text-[14px] text-[var(--color-text-muted)]">
        No config preview available yet.
        <Button variant="secondary" size="sm" className="ml-2" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Sync info banner */}
      <div className="flex items-start gap-3 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-3">
        <p className="text-[14px] text-[var(--color-text-muted)] leading-[1.50]">
          Auto-sync keeps this config updated via{" "}
          <code className="rounded bg-[var(--color-surface)] px-1.5 py-0.5 font-bold text-[12px] text-[var(--color-primary)]">
            opencode-9router-sync
          </code>
          .
        </p>
      </div>

      {/* Slim first-time setup banner */}
      {variant === "slim" && (
        <div className="rounded border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/10 px-3 py-2 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold text-[var(--color-danger)] shrink-0">First-time setup:</span>
            <code className="text-[14px] font-bold select-all truncate text-[var(--color-danger)]">
              npx -y -p @9router/opencode-9router-sync plugin-register --skills=yes
            </code>
            <span className="text-[12px] text-[var(--color-danger)]/70 shrink-0">(run once)</span>
          </div>
          <p className="text-[12px] text-[var(--color-danger)]/60">
            Registers agents and hooks. Use <code className="text-[var(--color-danger)]/70">--skills=yes</code> to also install community skills.
          </p>
        </div>
      )}

      {/* Main config preview */}
      <div className="rounded border border-[var(--color-border)] overflow-hidden bg-[var(--color-surface)]">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-alt)] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">data_object</span>
            <span className="text-[14px] font-bold text-[var(--color-text-main)]">opencode.json</span>
          </div>
          <div className="flex items-center gap-2">
            {requireApiKey && (
              <span className="flex items-center gap-1 rounded border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-2 py-0.5 text-[12px] text-[var(--color-warning)]">
                <span className="material-symbols-outlined text-[12px]">key</span>
                Requires valid API key
              </span>
            )}
            <Button variant="ghost" size="sm" icon="download" onClick={() => downloadFile(prettyJson(opencodeConfig), "opencode.json")}>
              Download
            </Button>
            <Button variant="ghost" size="sm" icon={copied ? "check" : "content_copy"} onClick={() => { navigator.clipboard.writeText(prettyJson(opencodeConfig)); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
        <pre className="max-h-[32rem] overflow-auto bg-[var(--color-surface)] px-4 py-4 text-[13px] leading-[1.60] text-[var(--color-text-main)] custom-scrollbar">
          <code>{prettyJson(opencodeConfig)}</code>
        </pre>
      </div>

      {/* Variant artifact preview */}
      {variantArtifact && (
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-alt)] px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">tune</span>
              <span className="text-[14px] font-bold text-[var(--color-text-main)]">{variantArtifact.filename}</span>
              <span className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[14px] text-[var(--color-text-muted)]">Preset artifact</span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => handleCopy(prettyJson(variantArtifact.content))}>
                Copy
              </Button>
              <Button variant="ghost" size="sm" icon="download" onClick={() => downloadFile(prettyJson(variantArtifact.content), variantArtifact.filename)}>
                Download
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Tips */}
      <div className="space-y-1.5 text-[14px] text-[var(--color-text-muted)]">
        <p className="flex items-start gap-2 leading-[1.50]">
          <span>•</span>
          <span>
            Set default model: <code className="rounded bg-[var(--color-bg-alt)] px-1.5 py-0.5 font-bold text-[12px] text-[var(--color-warning)]">9router/cx/model-name</code>
          </span>
        </p>
        <p className="flex items-start gap-2 leading-[1.50]">
          <span>•</span>
          <span>
            Place at <code className="break-all rounded bg-[var(--color-bg-alt)] px-1.5 py-0.5 font-bold text-[12px] text-[var(--color-warning)]">~/.config/opencode/opencode.json</code>
          </span>
        </p>
      </div>
    </div>
  );
}

/* ── Advanced Overrides Collapsible ────────────────────────────── */

function AdvancedOverridesCollapsible({ preferences, preview, modelCatalog, saving, error, onSave, activeProviders, modelAliases }) {
  const variant = preferences?.variant || "openagent";
  const safePreview = sanitizeSensitiveConfig(preview || null);
  const [editMode, setEditMode] = useState(false);
  const [draftJson, setDraftJson] = useState("");
  const [jsonError, setJsonError] = useState("");

  const variantArtifact = useMemo(() => {
    try {
      if (variant === "openagent" && safePreview?.ohMyOpencode) {
        return { filename: "oh-my-openagent.json", content: safePreview.ohMyOpencode };
      }
      if (variant === "slim" && safePreview?.ohMyOpenCodeSlim) {
        return { filename: "oh-my-opencode-slim.json", content: safePreview.ohMyOpenCodeSlim };
      }
    } catch (err) {
      console.error("Error processing variant artifact in AdvancedOverridesCollapsible:", err);
    }
    return null;
  }, [variant, safePreview]);

  const currentOverrides = preferences?.advancedOverrides?.[variant] || {};

  const title = variant === "slim"
    ? "Advanced config: Oh My OpenCode Slim"
    : "Advanced config: Oh My Open Agent";

  const handleEditClick = () => {
    setDraftJson(prettyJson(currentOverrides));
    setJsonError("");
    setEditMode(true);
  };

  const handleSaveOverrides = () => {
    try {
      const parsed = JSON.parse(draftJson);
      if (typeof parsed !== "object" || Array.isArray(parsed)) {
        setJsonError("Must be a valid JSON object");
        return;
      }
      onSave({ advancedOverrides: { ...preferences.advancedOverrides, [variant]: parsed } });
      setEditMode(false);
      setJsonError("");
    } catch (err) {
      setJsonError(err.message || "Invalid JSON");
    }
  };

  const handleCancelEdit = () => {
    setEditMode(false);
    setJsonError("");
  };

  return (
    <details className="group/details rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <span className="flex items-center gap-3 text-[16px] font-bold text-[var(--color-text-main)]">
          <span className="flex h-6 w-6 items-center justify-center rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] text-[14px] text-[var(--color-text-muted)]" aria-hidden="true">
            ▶
          </span>
          {title}
        </span>
        <span className="material-symbols-outlined text-[18px] text-[var(--color-text-muted)] transition-transform duration-200 group-open/details:rotate-180">
          expand_more
        </span>
      </summary>
      <div className="border-t border-[var(--color-border)] px-4 py-4 space-y-4">
        {/* Advanced Config Editor with Agent/Category Assignments */}
        <AdvancedConfigEditor
          variant={variant}
          preferences={preferences}
          availableModels={Object.keys(preview?.opencode?.provider?.["9router"]?.models || {})}
          onSave={onSave}
          saving={saving}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
        />

        {/* Generated artifact preview */}
        {variantArtifact && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[16px] font-bold text-[var(--color-text-main)]">{variantArtifact.filename}</p>
                <p className="mt-1 text-[14px] text-[var(--color-text-muted)] leading-[2.00]">
                  Generated advanced config for the selected variant.
                </p>
              </div>
              <Button variant="secondary" size="sm" icon="download" onClick={() => downloadFile(prettyJson(variantArtifact.content), variantArtifact.filename)}>
                Download
              </Button>
            </div>
            <pre className="max-h-[18rem] overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 text-[13px] leading-[1.60] text-[var(--color-text-main)] custom-scrollbar">
              <code>{prettyJson(variantArtifact.content)}</code>
            </pre>
          </div>
        )}

        {/* Raw JSON Editor (Advanced) */}
        <details className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)]">
          <summary className="cursor-pointer px-3 py-2 text-[14px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] transition-colors">
            Advanced: Edit Raw JSON
          </summary>
          <div className="border-t border-[var(--color-border)] px-3 py-3 space-y-3">
            {editMode ? (
              <>
                <textarea
                  value={draftJson}
                  onChange={(e) => setDraftJson(e.target.value)}
                  className="w-full h-64 px-3 py-2 text-[14px] rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)] text-[var(--color-text-main)] focus:border-[var(--color-primary)]/30 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]/20"
                  placeholder='{\n  "agentAssignments": {\n    "explorer": "cx/gpt-5.3-codex"\n  }\n}'
                />
                {jsonError && (
                  <p className="text-[14px] text-[var(--color-danger)]">{jsonError}</p>
                )}
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={handleCancelEdit}>
                    Cancel
                  </Button>
                  <Button variant="secondary" size="sm" onClick={handleSaveOverrides} disabled={saving} loading={saving}>
                    {saving ? "Saving..." : "Save JSON"}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <pre className="max-h-[18rem] overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 text-[13px] leading-[1.60] text-[var(--color-text-main)] custom-scrollbar">
                  <code>{Object.keys(currentOverrides).length > 0 ? prettyJson(currentOverrides) : "{}"}</code>
                </pre>
                <Button variant="secondary" size="sm" onClick={handleEditClick}>
                  Edit JSON
                </Button>
              </>
            )}
          </div>
        </details>
      </div>
    </details>
  );
}

/* ── main page ─────────────────────────────────────────────────── */

export default function OpenCodePageClient() {
  const [activeTab, setActiveTab] = useState("setup"); // 'setup' | 'quickstart' | 'tokens'
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [preferences, setPreferences] = useState(null);
  const [preview, setPreview] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [savingKey, setSavingKey] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [tokenError, setTokenError] = useState("");
  const [tokenCreating, setTokenCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState("");
  const [pluginInput, setPluginInput] = useState("");
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [requireApiKey, setRequireApiKey] = useState(false);
  const [apiKeys, setApiKeys] = useState([]);
  const [selectedApiKey, setSelectedApiKey] = useState("");

  const saveTimeoutRef = useRef(null);

  const normalizedPreferences = useMemo(() => {
    const defaults = {
      variant: "openagent",
      customTemplate: null,
      defaultModel: null,
      modelSelectionMode: "exclude",
      includedModels: [],
      excludedModels: [],
      customPlugins: [],
      mcpServers: [],
      envVars: [],
      advancedOverrides: { openagent: {}, slim: {}, custom: {} },
    };
    return preferences ? { ...defaults, ...preferences } : defaults;
  }, [preferences]);

  const modelCatalog = useMemo(() => {
    return Array.isArray(preview?.catalogModels) ? preview.catalogModels : [];
  }, [preview]);

  /* ── data loading ──────────────────────────────────────────── */

  const refreshPreview = useCallback(async () => {
    setPreviewLoading(true);
    setPreviewError("");
    try {
      const res = await fetch("/api/opencode/bundle/preview", { cache: "no-store" });
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch (parseErr) {
        console.error("Failed to parse preview response:", parseErr);
        throw new Error("Invalid response from server");
      }
      if (!res.ok) throw new Error(data?.error || "Failed to load preview");
      setPreview(data);
    } catch (err) {
      console.error("Error refreshing preview:", err);
      setPreviewError(getErrorMessage(err, "Failed to load preview"));
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const loadTokens = useCallback(async () => {
    try {
      const res = await fetch("/api/opencode/sync/tokens", { cache: "no-store" });
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch (parseErr) {
        console.error("Failed to parse tokens response:", parseErr);
        throw new Error("Invalid response from server");
      }
      if (!res.ok) throw new Error(data?.error || "Failed to load tokens");
      setTokens(data.tokens || []);
    } catch (err) {
      console.error("Error loading tokens:", err);
    }
  }, []);

  const savePreferences = useCallback(
    async (patch, saveLabel = "saving") => {
      setSavingKey(saveLabel);
      setError("");
      setCreatedToken("");
      try {
        const res = await fetch("/api/opencode/preferences", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        const text = await res.text();
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch (parseErr) {
          console.error("Failed to parse save response:", parseErr);
          throw new Error("Invalid response from server");
        }
        if (!res.ok) throw new Error(data?.error || "Failed to save");
        setPreferences(data.preferences || null);
        await refreshPreview();
      } catch (err) {
        console.error("Error saving preferences:", err);
        setError(getErrorMessage(err, "Failed to save"));
        throw err;
      } finally {
        setSavingKey("");
      }
    },
    [refreshPreview]
  );

  const createToken = useCallback(
    async ({ name }) => {
      setTokenCreating(true);
      setTokenError("");
      setCreatedToken("");
      try {
        const res = await fetch("/api/opencode/sync/tokens", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const text = await res.text();
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch (parseErr) {
          console.error("Failed to parse token response:", parseErr);
          throw new Error("Invalid response from server");
        }
        if (!res.ok) throw new Error(data?.error || "Failed to create token");
        setCreatedToken(data.token || "");
        await loadTokens();
      } catch (err) {
        console.error("Error creating token:", err);
        setTokenError(getErrorMessage(err, "Failed to create token"));
      } finally {
        setTokenCreating(false);
      }
    },
    [loadTokens]
  );

  useEffect(() => {
    let cancelled = false;
    async function loadData() {
      setLoading(true);
      setError("");
      try {
        const [prefRes, prevRes, tokRes, provRes, aliasRes, settingsRes, keysRes] = await Promise.all([
          fetch("/api/opencode/preferences"),
          fetch("/api/opencode/bundle/preview"),
          fetch("/api/opencode/sync/tokens"),
          fetch("/api/providers"),
          fetch("/api/models/alias"),
          fetch("/api/settings"),
          fetch("/api/keys"),
        ]);
        
        // Safe JSON parsing with error handling
        const safeJsonParse = async (res, fallback = {}) => {
          try {
            const text = await res.text();
            if (!text || text.trim() === "") return fallback;
            return JSON.parse(text);
          } catch (err) {
            console.error(`JSON parse error for ${res.url}:`, err);
            return fallback;
          }
        };
        
        const [prefData, prevData, tokData, provData, aliasData, settingsData, keysData] = await Promise.all([
          safeJsonParse(prefRes, {}),
          safeJsonParse(prevRes, {}),
          safeJsonParse(tokRes, {}),
          safeJsonParse(provRes, {}),
          safeJsonParse(aliasRes, {}),
          safeJsonParse(settingsRes, {}),
          safeJsonParse(keysRes, {}),
        ]);
        
        if (!prefRes.ok) throw new Error(prefData?.error || "Failed to load preferences");
        if (!prevRes.ok) throw new Error(prevData?.error || "Failed to load preview");
        if (!tokRes.ok) throw new Error(tokData?.error || "Failed to load tokens");
        if (cancelled) return;
        setPreferences(prefData.preferences || null);
        setPreview(prevData);
        setTokens(tokData.tokens || []);
        if (provRes.ok) setActiveProviders(provData.connections || []);
        if (aliasRes.ok) setModelAliases(aliasData.aliases || {});
        if (settingsRes.ok) setRequireApiKey(settingsData.requireApiKey || false);
        if (keysRes.ok) {
          const keys = keysData.keys || [];
          setApiKeys(keys);
          // Auto-select first active key if requireApiKey is enabled
          if (settingsData.requireApiKey && keys.length > 0) {
            const firstActiveKey = keys.find(k => k.isActive !== false);
            if (firstActiveKey) setSelectedApiKey(firstActiveKey.key);
          }
        }
      } catch (err) {
        if (cancelled) return;
        console.error("Error loading OpenCode data:", err);
        setError(err?.message || "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadData();
    return () => { cancelled = true; };
  }, []);

  /* ── handlers matching cliproxyapi-dashboard patterns ──────── */

  const handleVariantChange = (variant) => {
    savePreferences({ variant, customTemplate: variant === "custom" ? (normalizedPreferences.customTemplate || "minimal") : null }, "variant");
  };

  const handleAddPlugin = () => {
    const trimmed = pluginInput.trim();
    if (!trimmed) return;
    const current = normalizedPreferences.customPlugins || [];
    if (current.includes(trimmed)) return;
    savePreferences({ customPlugins: [...current, trimmed] }, "plugins");
    setPluginInput("");
  };

  const handleRemovePlugin = (plugin) => {
    const current = normalizedPreferences.customPlugins || [];
    savePreferences({ customPlugins: current.filter((p) => p !== plugin) }, "plugins");
  };

  const handleAddMcp = (mcp) => {
    const current = normalizedPreferences.mcpServers || [];
    const stored = mcp.type === "remote"
      ? { name: mcp.name, type: "remote", url: mcp.url }
      : { name: mcp.name, type: "local", command: mcp.command.split(/\s+/) };
    savePreferences({ mcpServers: [...current, stored] }, "mcp servers");
  };

  const handleRemoveMcp = (name) => {
    const current = normalizedPreferences.mcpServers || [];
    savePreferences({ mcpServers: current.filter((m) => m.name !== name) }, "mcp servers");
  };

  const handleToggleMcpEnabled = (name) => {
    const current = normalizedPreferences.mcpServers || [];
    savePreferences({
      mcpServers: current.map((m) =>
        m.name === name ? { ...m, disabled: m.disabled !== true } : m
      ),
    }, "mcp servers");
  };

  const handleAddEnvVar = (envVar) => {
    const current = normalizedPreferences.envVars || [];
    savePreferences({ envVars: [...current, envVar] }, "env vars");
  };

  const handleRemoveEnvVar = (key) => {
    const current = normalizedPreferences.envVars || [];
    savePreferences({ envVars: current.filter((env) => env.key !== key) }, "env vars");
  };

  // Build the effective plugin list for display (matching cliproxyapi-dashboard logic)
  const effectivePlugins = useMemo(() => {
    const variant = normalizedPreferences.variant;
    const base = [PLUGIN_SYNC];
    if (variant === "openagent") base.push(PLUGIN_OPENAGENT);
    else if (variant === "slim") base.push(PLUGIN_SLIM);
    const custom = normalizedPreferences.customPlugins || [];
    const all = [...base, ...custom.filter((p) => !base.includes(p))];
    return all;
  }, [normalizedPreferences]);

  /* ── render ────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="h-[200px] rounded border border-[var(--color-border)] bg-[var(--color-surface)] animate-pulse" />
        <div className="h-[400px] rounded border border-[var(--color-border)] bg-[var(--color-surface)] animate-pulse" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
        {/* Header */}
        <section className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-[var(--color-text-main)]">
          <h1 className="text-[38px] font-bold leading-[1.50]">
            OpenCode Quick Start
          </h1>
          <p className="mt-1 text-[16px] font-normal leading-[1.50] text-[var(--color-text-muted)]">
            Configure your OpenCode setup, generate config, and manage auto-sync from one place.
          </p>
        </section>

        {/* Global error */}
        {error && (
          <div className="rounded border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/10 px-4 py-3 text-[14px] text-[var(--color-danger)] leading-[1.50]">
            {error}
          </div>
        )}

        {savingKey && (
          <p className="text-[14px] text-[var(--color-text-muted)] leading-[2.00]">Saving {savingKey}…</p>
        )}

        {/* Tabs */}
        <div className="flex border-b border-[var(--color-border)]">
          <button
            onClick={() => setActiveTab("setup")}
            className={cn(
              "px-4 py-2 text-[16px] font-medium leading-[1.00] transition-colors cursor-pointer",
              activeTab === "setup"
                ? "border-b-2 border-[var(--color-text-muted)] text-[var(--color-text-main)]"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-main)]"
            )}
          >
            Setup
          </button>
          <button
            onClick={() => setActiveTab("quickstart")}
            className={cn(
              "px-4 py-2 text-[16px] font-medium leading-[1.00] transition-colors cursor-pointer",
              activeTab === "quickstart"
                ? "border-b-2 border-[var(--color-text-muted)] text-[var(--color-text-main)]"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-main)]"
            )}
          >
            Quickstart
          </button>
          <button
            onClick={() => setActiveTab("tokens")}
            className={cn(
              "px-4 py-2 text-[16px] font-medium leading-[1.00] transition-colors cursor-pointer",
              activeTab === "tokens"
                ? "border-b-2 border-[var(--color-text-muted)] text-[var(--color-text-main)]"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-main)]"
            )}
          >
            Tokens
          </button>
        </div>

        {/* Tab Content */}
        <div className={activeTab === "setup" ? "flex flex-col gap-6" : "hidden"}>
        {/* Model Selection */}
        <section id="model-selection" className="scroll-mt-24">
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-main)]">
            <div className="border-b border-[var(--color-border)] px-6 py-5">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-[20px] text-[var(--color-primary)]">model_training</span>
                <div>
                  <h3 className="text-[16px] font-bold">Model Selection</h3>
                  <p className="mt-1 text-[14px] text-[var(--color-text-muted)]">Choose which models appear in your generated config.</p>
                </div>
              </div>
            </div>
            <div className="p-6">
              <ModelSelector
                preferences={normalizedPreferences}
                modelCatalog={modelCatalog}
                saving={savingKey === "models"}
                onSave={(patch) => savePreferences(patch, "models")}
                activeProviders={activeProviders}
                modelAliases={modelAliases}
              />
            </div>
          </div>
        </section>
        </div>

        {/* Tab Content - Quickstart */}
        <div className={activeTab === "quickstart" ? "flex flex-col gap-6" : "hidden"}>

        {/* Generate Config — main Quick Start card */}
        <section id="generate-config" className="scroll-mt-24">
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-main)]">
            <div className="border-b border-[var(--color-border)] px-6 py-5">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-[20px] text-[var(--color-primary)]">terminal</span>
                <div>
                  <h3 className="flex items-center gap-3 text-[16px] font-bold">
                    <span className="flex h-6 w-6 items-center justify-center rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] text-[14px] text-[var(--color-text-muted)]" aria-hidden="true">
                      ▶
                    </span>
                    Using with OpenCode
                  </h3>
                </div>
              </div>
            </div>
            <div className="p-6">
              <div className="space-y-5">
              {/* Variant toggle */}
              <VariantToggle
                variant={normalizedPreferences.variant}
                onVariantChange={handleVariantChange}
              />

              {/* Default Model Selector */}
              <div>
                <Select
                  label="Default Model"
                  value={normalizedPreferences.defaultModel || ""}
                  onChange={(e) => savePreferences({ defaultModel: e.target.value || null }, "default model")}
                  options={[
                    { value: "", label: "Auto (first model)" },
                    ...(() => {
                      const selectedModelIds = normalizedPreferences.modelSelectionMode === "include"
                        ? normalizedPreferences.includedModels || []
                        : Object.keys(preview?.opencode?.provider?.["9router"]?.models || {});
                      
                      return selectedModelIds.sort().map(id => {
                        const model = modelCatalog.find(m => m.id === id);
                        const displayName = model?.name || id;
                        return { value: id, label: `${id} (${displayName})` };
                      });
                    })()
                  ]}
                  hint="Model to use by default in generated config."
                />
              </div>

              {/* API Key Selector */}
              {requireApiKey ? (
                <div>
                  <Select
                    label="API Key"
                    value={selectedApiKey}
                    onChange={(e) => setSelectedApiKey(e.target.value)}
                    options={[
                      ...apiKeys
                        .filter(k => k.isActive !== false)
                        .map(k => ({
                          value: k.key,
                          label: k.name || k.key.slice(0, 20) + "..."
                        }))
                    ]}
                    hint="API key to use in generated config (endpoint requires API key)."
                  />
                </div>
              ) : (
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2">
                  <div className="flex items-center gap-2 text-[14px]">
                    <span className="material-symbols-outlined text-[14px] text-[var(--color-info)]">info</span>
                    <span className="text-[var(--color-text-muted)]">
                      API key will be set to <code className="text-[var(--color-primary)]">sk_9router</code> (endpoint doesn&apos;t require API key)
                    </span>
                  </div>
                </div>
              )}

              {/* Custom template selector */}
              {normalizedPreferences.variant === "custom" && (
                <div className="max-w-xs">
                  <Select
                    label="Custom template"
                    value={normalizedPreferences.customTemplate || "minimal"}
                    onChange={(e) => savePreferences({ customTemplate: e.target.value }, "template")}
                    options={[
                      { value: "minimal", label: "Minimal" },
                      { value: "opinionated", label: "Opinionated" },
                    ]}
                    hint="Minimal is lighter. Opinionated adds more defaults."
                  />
                </div>
              )}

              {/* Plugins */}
              <PluginSection
                plugins={effectivePlugins}
                pluginInput={pluginInput}
                onPluginInputChange={setPluginInput}
                onAddPlugin={handleAddPlugin}
                onRemovePlugin={(plugin) => {
                  // Don't allow removing core plugins
                  if (plugin === PLUGIN_SYNC || plugin === PLUGIN_OPENAGENT || plugin === PLUGIN_SLIM) return;
                  handleRemovePlugin(plugin);
                }}
              />

              {/* MCP Servers */}
              <McpSection
                mcps={normalizedPreferences.mcpServers || []}
                onAddMcp={handleAddMcp}
                onRemoveMcp={handleRemoveMcp}
                onToggleMcpEnabled={handleToggleMcpEnabled}
              />

              {/* Environment Variables */}
              <EnvVarsSection
                envVars={normalizedPreferences.envVars || []}
                onAddEnvVar={handleAddEnvVar}
                onRemoveEnvVar={handleRemoveEnvVar}
              />

              {/* Divider */}
              <div className="border-t border-[var(--color-border)]" />

              {/* Config Preview */}
              <ConfigPreview
                preview={preview}
                variant={normalizedPreferences.variant}
                loading={previewLoading}
                error={previewError}
                onRefresh={refreshPreview}
                selectedApiKey={selectedApiKey}
                requireApiKey={requireApiKey}
              />
              </div>
            </div>
          </div>
        </section>

        {/* Advanced overrides — collapsible */}
        {normalizedPreferences.variant !== "custom" && (
          <section id="advanced-config" className="scroll-mt-24">
            <AdvancedOverridesCollapsible
              preferences={normalizedPreferences}
              preview={preview}
              modelCatalog={modelCatalog}
              saving={savingKey === "advanced overrides"}
              error={error}
              onSave={(patch) => savePreferences(patch, "advanced overrides")}
              activeProviders={activeProviders}
              modelAliases={modelAliases}
            />
          </section>
        )}
        </div>

        {/* Tab Content - Tokens */}
        <div className={activeTab === "tokens" ? "flex flex-col gap-6" : "hidden"}>

        {/* Auto-sync tokens */}
        <section id="sync-tokens" className="scroll-mt-24">
          <TokenManagerCard
            tokens={tokens}
            creating={tokenCreating}
            createError={tokenError}
            createdToken={createdToken}
            onCreate={createToken}
          />
        </section>
        </div>
    </div>
  );
}
