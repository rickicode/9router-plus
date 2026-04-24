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
        "rounded border px-5 py-[1.125rem] text-left transition-colors duration-200",
        active
          ? "border-primary/35 bg-[var(--color-primary-soft)]"
          : "border-border bg-[var(--color-surface)] hover:border-primary/30 hover:bg-[var(--color-bg-alt)]"
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <div className="text-sm font-semibold text-text-main">{title}</div>
          <div className="text-xs leading-5 text-text-muted">{description}</div>
        </div>
        <span className={cn("material-symbols-outlined mt-0.5 text-[18px]", active ? "text-primary" : "text-text-muted")}>
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
      className="rounded border-border bg-[var(--color-bg-alt)]"
    >
      <div className="space-y-7">
        <div className="rounded border border-primary/10 bg-[var(--color-primary-soft)] px-5 py-[1.125rem]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">Model visibility</p>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-text-muted">
                Choose whether this config starts from the full catalog or from an allowlist. This keeps the highest-impact decision grouped before preset selection.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant={mode === "include" ? "primary" : "secondary"} size="sm">
                {mode === "include" ? "Allowlist mode" : "Allowlist available"}
              </Badge>
              <Badge variant={mode === "exclude" ? "primary" : "secondary"} size="sm">
                {mode === "exclude" ? "Catalog mode" : "Catalog available"}
              </Badge>
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

        <Card.Section className="rounded border border-border bg-[var(--color-surface)] px-5 py-5">
          <div className="mb-4 space-y-1">
            <p className="text-sm font-semibold text-text-main">Add a model rule</p>
            <p className="text-xs leading-5 text-text-muted">Pick from the models currently available so the generated config stays valid and easy to review.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => setPickerOpen(true)} loading={saving} disabled={availableOptions.length === 0}>
              {mode === "include" ? "Add allowed model" : "Add excluded model"}
            </Button>
            <p className="text-xs text-text-muted">
              {availableOptions.length > 0
                ? `${availableOptions.length} available model${availableOptions.length === 1 ? "" : "s"} ready to pick.`
                : "All currently available models are already in this list."}
            </p>
          </div>
        </Card.Section>

        {error ? <p className="text-sm text-[var(--color-danger)]">{error}</p> : null}

        <div className="space-y-3.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-text-main">Selected model rules</p>
              <p className="text-xs text-text-muted">Keep this list tight so the preview stays intentional.</p>
            </div>
            {selectedModels.length > 0 ? <Badge size="sm">{selectedModels.length} selected</Badge> : null}
          </div>

          <div className="flex min-h-[64px] flex-wrap gap-2.5 rounded border border-dashed border-border bg-[var(--color-bg-alt)] p-4">
            {selectedModels.length === 0 ? (
              <p className="text-sm text-text-muted">
                {mode === "include"
                  ? "No included models selected yet."
                  : "No excluded models configured. The generated config will keep the full catalog."}
              </p>
            ) : (
              selectedModels.map((modelId) => (
                <Badge key={modelId} className="gap-2 pr-1">
                  <span className="max-w-[240px] truncate">{modelId}</span>
                  <button
                    type="button"
                    className="rounded-full p-0.5 hover:bg-[var(--color-bg-alt)]"
                    onClick={() => removeModel(modelId)}
                    aria-label={`Remove ${modelId}`}
                  >
                    <span className="material-symbols-outlined text-[14px]">close</span>
                  </button>
                </Badge>
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
