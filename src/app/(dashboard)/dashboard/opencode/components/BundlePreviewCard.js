"use client";

import { useState } from "react";
import { Badge, Button, Card, Select } from "@/shared/components";
import { sanitizeSensitiveConfig } from "@/lib/opencodeSync/schema";
import { cn } from "@/shared/utils/cn";

const PUBLIC_ARTIFACTS_COPY = "Only server-provided public artifacts appear here.";

function getMissingMainArtifactCopy() {
  return `${PUBLIC_ARTIFACTS_COPY} The server did not provide a public opencode.json preview for this bundle yet, so there is no main artifact to copy or download.`;
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

function getOpenCodeArtifact(preview = {}) {
  if (preview?.opencode && typeof preview.opencode === "object" && !Array.isArray(preview.opencode)) {
    return {
      id: "opencode",
      label: "opencode.json",
      title: "OpenCode config",
      filename: "opencode.json",
      description: "Use this as ~/.config/opencode/opencode.json.",
      content: preview.opencode,
    };
  }

  return null;
}

function getSelectedVariantArtifact(preview = {}, selectedVariant = "custom") {
  if (
    selectedVariant === "openagent" &&
    preview?.ohMyOpencode &&
    typeof preview.ohMyOpencode === "object" &&
    !Array.isArray(preview.ohMyOpencode)
  ) {
    return {
      id: "advanced",
      label: "Preset artifact",
      title: "Oh My Open Agent config",
      filename: "oh-my-openagent.json",
      description: "Selected preset artifact for the recommended Open Agent variant.",
      content: preview.ohMyOpencode,
      badge: "Oh My Open Agent",
    };
  }

  if (
    selectedVariant === "slim" &&
    preview?.ohMyOpenCodeSlim &&
    typeof preview.ohMyOpenCodeSlim === "object" &&
    !Array.isArray(preview.ohMyOpenCodeSlim)
  ) {
    return {
      id: "advanced",
      label: "Preset artifact",
      title: "Oh My OpenCode Slim config",
      filename: "oh-my-opencode-slim.json",
      description: "Selected preset artifact for the slim variant.",
      content: preview.ohMyOpenCodeSlim,
      badge: "Oh My OpenCode Slim",
    };
  }

  return null;
}

function getDefaultModelLabel(opencodeConfig = {}) {
  if (typeof opencodeConfig?.model !== "string" || !opencodeConfig.model.trim()) {
    return "Not configured";
  }

  const model = opencodeConfig.model.trim();
  const [, ...rest] = model.split("/");
  return rest.length > 0 ? rest.join("/") : model;
}

function getProviderModelCount(opencodeConfig = {}) {
  const providerEntries = Object.values(opencodeConfig?.provider || {});
  return providerEntries.reduce((count, provider) => count + Object.keys(provider?.models || {}).length, 0);
}

function StatTile({ label, value, note, icon }) {
  return (
    <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#f8f7f7] px-[1.125rem] py-4 font-['Berkeley_Mono']">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#9a9898] leading-[1.50]">{label}</p>
          <p className="text-[16px] font-bold text-[#201d1d] break-all leading-[1.50]">{value}</p>
          {note ? <p className="text-[14px] text-[#9a9898] leading-[2.00]">{note}</p> : null}
        </div>
        <span className="material-symbols-outlined text-[18px] text-[#ec4899]">{icon}</span>
      </div>
    </div>
  );
}

function ConfigViewTabs({ views, activeView, onChange }) {
  return (
    <>
      <div className="sm:hidden">
        <Select
          label="Config view"
          value={activeView}
          onChange={(event) => onChange(event.target.value)}
          options={views.map((view) => ({ value: view.id, label: view.label }))}
        />
      </div>

      <div className="hidden flex-wrap gap-2 sm:flex">
        {views.map((view) => (
          <button
            key={view.id}
            type="button"
            onClick={() => onChange(view.id)}
            className={cn(
              "border-b-2 px-3 py-1.5 text-[16px] font-medium leading-[1.00] transition-all font-['Berkeley_Mono']",
              activeView === view.id
                ? "border-[#9a9898] text-[#fdfcfc] bg-[#201d1d]"
                : "border-transparent bg-transparent text-[#9a9898] hover:border-[#ec4899] hover:text-[#fdfcfc]"
            )}
          >
            {view.label}
          </button>
        ))}
      </div>
    </>
  );
}

export default function BundlePreviewCard({ preview, selectedVariant = "custom", loading = false, error = "", onRefresh }) {
  const safePreview = sanitizeSensitiveConfig(preview || null);
  const opencodeArtifact = getOpenCodeArtifact(safePreview);
  const opencodeConfig = opencodeArtifact?.content || null;
  const selectedVariantArtifact = getSelectedVariantArtifact(safePreview, selectedVariant);
  const catalogModels = Array.isArray(safePreview?.catalogModels) ? safePreview.catalogModels : [];
  const modelCount = getProviderModelCount(opencodeConfig) || catalogModels.length;
  const pluginList = Array.isArray(opencodeConfig?.plugin) ? opencodeConfig.plugin : [];

  const views = [
    ...(opencodeArtifact ? [opencodeArtifact] : []),
    ...(selectedVariantArtifact ? [selectedVariantArtifact] : []),
  ];
  const hasMainArtifact = Boolean(opencodeArtifact);
  const fallbackSecondaryViewId = views.find((view) => view.id !== "opencode")?.id || null;

  const [activeView, setActiveView] = useState("opencode");
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showMoreViews, setShowMoreViews] = useState(false);

  const resolvedActiveView = views.some((view) => view.id === activeView)
    ? activeView
    : hasMainArtifact
      ? "opencode"
      : fallbackSecondaryViewId;
  const currentView = resolvedActiveView ? views.find((view) => view.id === resolvedActiveView) || null : null;
  const currentContent = currentView ? prettyJson(currentView.content) : "";
  const primaryViews = views.filter((view) => view.id === "opencode");
  const secondaryViews = views.filter((view) => view.id !== "opencode");

  const handleCopy = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;

    if (!currentView) return;

    await navigator.clipboard.writeText(currentContent);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] p-6 font-['Berkeley_Mono'] text-[#fdfcfc]">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-[16px] font-bold leading-[1.50]">
            <span className="material-symbols-outlined text-[#ec4899]">data_object</span>
            Generated config files
          </h2>
          <p className="mt-1 text-[16px] font-normal leading-[1.50] text-[#9a9898]">
            {hasMainArtifact ? "Quick Start starts with the server-provided opencode.json artifact." : PUBLIC_ARTIFACTS_COPY}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasMainArtifact ? (
            <button 
              className="rounded bg-[#201d1d] px-[20px] py-[4px] text-[16px] font-medium leading-[2.00] text-[#fdfcfc] hover:bg-[#ec4899] transition-colors border border-[rgba(15,0,0,0.12)] cursor-pointer"
              onClick={() => downloadTextFile(prettyJson(opencodeConfig), "opencode.json")}
            >
              Download opencode.json
            </button>
          ) : null}
          <button 
            className="rounded bg-[#201d1d] px-[20px] py-[4px] text-[16px] font-medium leading-[2.00] text-[#fdfcfc] hover:bg-[#ec4899] transition-colors border border-[rgba(15,0,0,0.12)] cursor-pointer disabled:opacity-50"
            onClick={onRefresh} 
            disabled={loading}
          >
            Refresh preview
          </button>
        </div>
      </div>

      <div className="space-y-7">
        {error ? (
          <div className="rounded border border-[#ff3b30] bg-[#201d1d] px-4 py-3 text-[14px] text-[#ff3b30]">
            {error}
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
          <StatTile
            label="Variant"
            value={selectedVariantArtifact?.badge || "Custom / No preset"}
            note={selectedVariantArtifact ? "Preset artifact available" : hasMainArtifact ? "Main config only" : "No public artifact"}
            icon="layers"
          />
          <StatTile
            label="Default model"
            value={getDefaultModelLabel(opencodeConfig)}
            note={`${modelCount} models`}
            icon="model_training"
          />
          <StatTile
            label="Plugins"
            value={`${pluginList.length} package${pluginList.length === 1 ? "" : "s"}`}
            note={pluginList.length > 0 ? pluginList.join(" • ") : "No plugins"}
            icon="extension"
          />
          <StatTile
            label="Version"
            value={safePreview?.version || "Not available"}
            note="Public sync contract"
            icon="fingerprint"
          />
        </div>

        <div className="space-y-6 rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] px-5 py-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2 text-[14px]">
                <span className="rounded border border-[rgba(15,0,0,0.12)] px-2 py-0.5 text-[#ec4899]">Quick Start-aligned</span>
                <span className="rounded border border-[rgba(15,0,0,0.12)] px-2 py-0.5 text-[#9a9898]">{modelCount} models</span>
                <span className="rounded border border-[rgba(15,0,0,0.12)] px-2 py-0.5 text-[#9a9898]">{pluginList.length} plugins</span>
                <span className="rounded border border-[rgba(15,0,0,0.12)] px-2 py-0.5 text-[#9a9898]">{selectedVariantArtifact?.badge || "No preset artifact"}</span>
              </div>
              <div>
                <h4 className="text-[16px] font-bold text-[#fdfcfc]">Choose the file you want to copy</h4>
                <p className="text-[16px] leading-[1.50] text-[#9a9898]">This preview centers the real generated opencode.json artifact first. {PUBLIC_ARTIFACTS_COPY}</p>
              </div>
            </div>
          </div>

          {hasMainArtifact ? (
            <ConfigViewTabs views={primaryViews} activeView={resolvedActiveView} onChange={setActiveView} />
          ) : (
            <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] p-[1.125rem] text-[14px] text-[#9a9898]">
              {getMissingMainArtifactCopy()}
            </div>
          )}

          {secondaryViews.length > 0 ? (
            <div className="space-y-3 rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] p-[1.125rem]">
              <button
                type="button"
                onClick={() => {
                  setShowMoreViews((value) => {
                    const nextValue = !value;
                    if (!nextValue && secondaryViews.some((view) => view.id === resolvedActiveView)) {
                      setActiveView(hasMainArtifact ? "opencode" : fallbackSecondaryViewId || "opencode");
                    }
                    return nextValue;
                  });
                }}
                className="flex w-full items-center justify-between gap-3 text-left"
              >
                <div>
                  <p className="text-[16px] font-bold text-[#fdfcfc]">More generated artifacts</p>
                  <p className="mt-1 text-[14px] text-[#9a9898]">Only true public artifacts beyond opencode.json stay secondary.</p>
                </div>
                <span
                  className={cn(
                    "material-symbols-outlined text-[18px] text-[#9a9898] transition-transform duration-200",
                    showMoreViews ? "rotate-180" : "rotate-0"
                  )}
                >
                  expand_more
                </span>
              </button>

              {showMoreViews ? (
                <div className="space-y-3">
                  <ConfigViewTabs
                    views={secondaryViews}
                    activeView={resolvedActiveView || secondaryViews[0]?.id || "advanced"}
                    onChange={setActiveView}
                  />
                  <p className="text-[14px] text-[#9a9898]">{PUBLIC_ARTIFACTS_COPY}</p>
                </div>
              ) : null}
            </div>
          ) : null}

          {currentView && resolvedActiveView ? (
            <button
              type="button"
              onClick={() => setIsExpanded((value) => !value)}
              className="flex items-center gap-2 rounded px-1 text-[14px] font-medium text-[#9a9898] transition-colors hover:text-[#fdfcfc] cursor-pointer"
            >
              <span
                className={cn(
                  "material-symbols-outlined text-[16px] transition-transform duration-200",
                  isExpanded ? "rotate-90" : "rotate-0"
                )}
              >
                chevron_right
              </span>
              {isExpanded ? "Hide file contents" : "Show file contents"}
            </button>
          ) : null}

          {isExpanded && currentView && resolvedActiveView ? (
            <div className="grid gap-5 2xl:grid-cols-[minmax(320px,0.82fr)_minmax(0,1.18fr)]">
              <div className="space-y-5 rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] px-5 py-5">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#9a9898]">Current view</p>
                  <h4 className="mt-1 text-[16px] font-bold text-[#fdfcfc]">{currentView?.title}</h4>
                  <p className="mt-1 text-[16px] text-[#9a9898]">{currentView?.description}</p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-3 py-3">
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#9a9898]">Filename</p>
                    <p className="mt-1 text-[16px] font-medium text-[#fdfcfc] break-all">{currentView?.filename}</p>
                  </div>
                  <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-3 py-3">
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#9a9898]">Contains</p>
                    <p className="mt-1 text-[16px] font-medium text-[#fdfcfc]">
                      {Array.isArray(currentView?.content)
                        ? `${currentView.content.length} items`
                        : `${Object.keys(currentView?.content || {}).length} top-level keys`}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2.5">
                  <button 
                    className="rounded bg-[#201d1d] px-[20px] py-[4px] text-[16px] font-medium leading-[2.00] text-[#fdfcfc] hover:bg-[#ec4899] transition-colors border border-[rgba(15,0,0,0.12)] cursor-pointer"
                    onClick={() => downloadTextFile(currentContent, currentView?.filename || "config.json")}
                  >
                    Download this file
                  </button>
                  <button 
                    className="rounded bg-transparent px-[20px] py-[4px] text-[16px] font-medium leading-[2.00] text-[#fdfcfc] hover:bg-[#201d1d] transition-colors border border-transparent hover:border-[rgba(15,0,0,0.12)] cursor-pointer"
                    onClick={handleCopy}
                  >
                    {copied ? "Copied" : "Copy file contents"}
                  </button>
                </div>
              </div>

              <div className="overflow-hidden rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d]">
                <div className="flex items-center justify-between border-b border-[rgba(15,0,0,0.12)] px-5 py-3.5">
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#9a9898]">Preview</p>
                    <p className="text-[16px] font-bold text-[#fdfcfc]">{currentView?.filename}</p>
                  </div>
                  <span className="rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-2 py-0.5 text-[14px] text-[#fdfcfc]">
                    sanitized
                  </span>
                </div>

                <pre className="max-h-[42rem] overflow-auto px-5 py-5 text-[14px] leading-[1.50] text-[#fdfcfc] font-['Berkeley_Mono']">
                  <code>{currentContent}</code>
                </pre>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
