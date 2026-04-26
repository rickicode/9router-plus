"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Card } from "@/shared/components";
import { cn } from "@/shared/utils/cn";
import OpenCodeModelSelectModal from "./OpenCodeModelSelectModal";

function SelectionModeButton({ active, title, description, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded border px-5 py-[1.125rem] text-left transition-colors duration-200 cursor-pointer font-['Berkeley_Mono']",
        active
          ? "border-[#ec4899] bg-[#302c2c]"
          : "border-[rgba(15,0,0,0.12)] bg-[#201d1d] hover:border-[#ec4899]/30 hover:bg-[#302c2c]"
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <div className="text-[16px] font-bold text-[#fdfcfc] leading-[1.50]">{title}</div>
          <div className="text-[16px] leading-[1.50] text-[#9a9898]">{description}</div>
        </div>
        <span className={cn("material-symbols-outlined mt-0.5 text-[18px]", active ? "text-[#ec4899]" : "text-[#9a9898]")}>
          {active ? "check_circle" : "radio_button_unchecked"}
        </span>
      </div>
    </button>
  );
}

export default function ModelSelectionCard({
  preferences,
  modelOptions = [],
  activeProviders = [],
  modelAliases = {},
  saving = false,
  error = "",
  onSave,
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const mode = preferences?.modelSelectionMode || "exclude";
  const listKey = mode === "include" ? "includedModels" : "excludedModels";
  const selectedModels = useMemo(() => preferences?.[listKey] || [], [preferences, listKey]);

  const availableOptions = useMemo(() => {
    return Array.from(new Set((modelOptions || []).filter(Boolean)))
      .filter((modelId) => !selectedModels.includes(modelId))
      .sort((left, right) => left.localeCompare(right));
  }, [modelOptions, selectedModels]);

  const addModel = (selection) => {
    const selections = Array.isArray(selection) ? selection : [selection];
    const nextModels = selections
      .map((item) => item?.value)
      .filter((modelId) => modelId && !selectedModels.includes(modelId) && availableOptions.includes(modelId));

    if (nextModels.length === 0) return;

    onSave?.({
      [listKey]: [...selectedModels, ...nextModels],
    });
  };

  const removeModel = (modelId) => {
    onSave?.({
      [listKey]: selectedModels.filter((item) => item !== modelId),
    });
  };

  return (
    <Card
      title="Choose models"
      subtitle="Choose which models you want included in the generated config."
      icon="model_training"
      className="rounded border-[rgba(15,0,0,0.12)] bg-[#201d1d] font-['Berkeley_Mono'] text-[#fdfcfc]"
    >
      <div className="space-y-7 p-6">
        <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] px-5 py-[1.125rem]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#9a9898] leading-[1.50]">Model visibility</p>
              <p className="mt-2 max-w-2xl text-[16px] leading-[1.50] text-[#9a9898]">
                Choose whether this config starts from the full catalog or from an allowlist. This keeps the highest-impact decision grouped before preset selection.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-[14px]">
              <span className={cn("rounded border border-[rgba(15,0,0,0.12)] px-2 py-0.5", mode === "include" ? "text-[#ec4899] bg-[#201d1d]" : "text-[#9a9898]")}>
                {mode === "include" ? "Allowlist mode" : "Allowlist available"}
              </span>
              <span className={cn("rounded border border-[rgba(15,0,0,0.12)] px-2 py-0.5", mode === "exclude" ? "text-[#ec4899] bg-[#201d1d]" : "text-[#9a9898]")}>
                {mode === "exclude" ? "Catalog mode" : "Catalog available"}
              </span>
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <SelectionModeButton
            active={mode === "include"}
            title="Include only"
            description="Only include the models you explicitly want in the generated config."
            onClick={() => onSave?.({ modelSelectionMode: "include" })}
          />
          <SelectionModeButton
            active={mode === "exclude"}
            title="Exclude from catalog"
            description="Start from the full catalog and hide only the models you do not want shown in the generated config."
            onClick={() => onSave?.({ modelSelectionMode: "exclude" })}
          />
        </div>

        <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] px-5 py-5">
          <div className="mb-4 space-y-1">
            <p className="text-[16px] font-bold text-[#fdfcfc]">Add a model rule</p>
            <p className="text-[14px] leading-[2.00] text-[#9a9898]">Pick from the models currently available so the generated config stays valid and easy to review.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button 
              className="rounded bg-[#201d1d] px-[20px] py-[4px] text-[16px] font-medium leading-[2.00] text-[#fdfcfc] hover:bg-[#ec4899] transition-colors border border-[rgba(15,0,0,0.12)] cursor-pointer disabled:opacity-50"
              onClick={() => setPickerOpen(true)} 
              disabled={availableOptions.length === 0}
            >
              {mode === "include" ? "Add allowed model" : "Add excluded model"}
            </button>
            <p className="text-[14px] text-[#9a9898] leading-[2.00]">
              {availableOptions.length > 0
                ? `${availableOptions.length} available model${availableOptions.length === 1 ? "" : "s"} ready to pick.`
                : "All currently available models are already in this list."}
            </p>
          </div>
        </div>

        {error ? <p className="text-[14px] text-[#ff3b30]">{error}</p> : null}

        <div className="space-y-3.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[16px] font-bold text-[#fdfcfc]">Selected model rules</p>
              <p className="text-[14px] leading-[2.00] text-[#9a9898]">Keep this list tight so the preview stays intentional.</p>
            </div>
            {selectedModels.length > 0 ? <span className="rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-2 py-0.5 text-[14px] text-[#9a9898]">{selectedModels.length} selected</span> : null}
          </div>

          <div className="flex min-h-[64px] flex-wrap gap-2.5 rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] p-4">
            {selectedModels.length === 0 ? (
              <p className="text-[16px] text-[#9a9898] leading-[1.50]">
                {mode === "include"
                  ? "No included models selected yet."
                  : "No excluded models configured. The generated config will keep the full catalog."}
              </p>
            ) : (
              selectedModels.map((modelId) => (
                <span key={modelId} className="flex items-center gap-2 pr-1 rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-2 py-0.5 text-[14px] text-[#fdfcfc]">
                  <span className="max-w-[240px] truncate">{modelId}</span>
                  <button
                    type="button"
                    className="rounded-full p-0.5 hover:text-[#ff3b30] cursor-pointer"
                    onClick={() => removeModel(modelId)}
                    aria-label={`Remove ${modelId}`}
                  >
                    <span className="material-symbols-outlined text-[14px]">close</span>
                  </button>
                </span>
              ))
            )}
          </div>
        </div>
      </div>

      <OpenCodeModelSelectModal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={addModel}
        selectedModel=""
        selectedModels={[]}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        title={mode === "include" ? "Add allowed model" : "Add excluded model"}
        multiSelect
        enabledModels={availableOptions}
        confirmLabel={mode === "include" ? "Add selected models" : "Exclude selected models"}
      />
    </Card>
  );
}
