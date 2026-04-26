"use client";

import { useState, useMemo } from "react";
import { Badge, Button, Select, ModelSelectModal } from "@/shared/components";
import { cn } from "@/shared/utils/cn";

// Agent roles for Oh My Open Agent
const AGENT_ROLES = {
  explorer: "Explorer",
  sisyphus: "Sisyphus",
  oracle: "Oracle",
  librarian: "Librarian",
  prometheus: "Prometheus",
  atlas: "Atlas",
};

// Category roles for Oh My Open Agent
const CATEGORY_ROLES = {
  deep: "Deep Thinking",
  quick: "Quick Tasks",
  "visual-engineering": "Visual Engineering",
  writing: "Writing",
  artistry: "Creative Work",
};

// Agent roles for Oh My OpenCode Slim
const SLIM_AGENT_ROLES = {
  core: "Core Agent",
  research: "Research Agent",
  execution: "Execution Agent",
};

// Category roles for Oh My OpenCode Slim
const SLIM_CATEGORY_ROLES = {
  default: "Default",
  "long-context": "Long Context",
  "low-latency": "Low Latency",
};

function ModelAssignmentRow({ name, label, currentModel, isOverride, onSelectClick, onClear }) {
  return (
    <div className="flex flex-col gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 sm:flex-row sm:items-center sm:justify-between text-[var(--color-text-main)]">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-[14px] font-bold text-[var(--color-text-main)]">{name}</p>
          {isOverride && (
            <span className="rounded border border-[var(--color-border)] bg-[var(--color-primary)]/10 px-2 py-0.5 text-[12px] text-[var(--color-primary)]">Custom</span>
          )}
        </div>
        <p className="truncate text-[12px] text-[var(--color-text-muted)]">{label}</p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onSelectClick}>
          {currentModel || "Auto (from chain)"}
        </Button>
        {isOverride && (
          <button
            type="button"
            onClick={onClear}
            className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors cursor-pointer"
            title="Clear override"
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        )}
      </div>
    </div>
  );
}

export default function AdvancedConfigEditor({ variant, preferences, availableModels, onSave, saving, activeProviders = [], modelAliases = {} }) {
  const [activeTab, setActiveTab] = useState("agents");
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [pendingAssignment, setPendingAssignment] = useState(null);
  
  const isSlim = variant === "slim";
  const agentRoles = isSlim ? SLIM_AGENT_ROLES : AGENT_ROLES;
  const categoryRoles = isSlim ? SLIM_CATEGORY_ROLES : CATEGORY_ROLES;
  
  const currentOverrides = preferences?.advancedOverrides?.[variant] || {};
  const agentAssignments = currentOverrides.agentAssignments || {};
  const categoryAssignments = currentOverrides.categoryAssignments || {};

  const handleAgentModelChange = (agent, model) => {
    const newAgentAssignments = { ...agentAssignments };
    if (model === undefined) {
      delete newAgentAssignments[agent];
    } else {
      newAgentAssignments[agent] = model;
    }
    
    const newOverrides = {
      ...currentOverrides,
      agentAssignments: Object.keys(newAgentAssignments).length > 0 ? newAgentAssignments : undefined,
    };
    
    onSave({ advancedOverrides: { ...preferences.advancedOverrides, [variant]: newOverrides } });
  };

  const handleCategoryModelChange = (category, model) => {
    const newCategoryAssignments = { ...categoryAssignments };
    if (model === undefined) {
      delete newCategoryAssignments[category];
    } else {
      newCategoryAssignments[category] = model;
    }
    
    const newOverrides = {
      ...currentOverrides,
      categoryAssignments: Object.keys(newCategoryAssignments).length > 0 ? newCategoryAssignments : undefined,
    };
    
    onSave({ advancedOverrides: { ...preferences.advancedOverrides, [variant]: newOverrides } });
  };

  const handleOpenModelSelect = (type, key) => {
    setPendingAssignment({ type, key });
    setShowModelSelect(true);
  };

  const handleModelSelected = (model) => {
    if (!pendingAssignment) return;
    const { type, key } = pendingAssignment;
    if (type === "agent") {
      handleAgentModelChange(key, model.value);
    } else {
      handleCategoryModelChange(key, model.value);
    }
    setShowModelSelect(false);
    setPendingAssignment(null);
  };

  const agentOverrideCount = Object.keys(agentAssignments).length;
  const categoryOverrideCount = Object.keys(categoryAssignments).length;

  return (
    <div className="space-y-4">
      {/* Tab Navigation */}
      <div className="flex items-center gap-2 border-b border-[var(--color-border)]">
        <button
          type="button"
          onClick={() => setActiveTab("agents")}
          className={cn(
            "px-4 py-2 text-[16px] font-medium transition-colors cursor-pointer leading-[1.00]",
            activeTab === "agents"
              ? "border-b-2 border-[var(--color-text-muted)] text-[var(--color-text-main)]"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text-main)]"
          )}
        >
          Agent Assignments
          {agentOverrideCount > 0 && (
            <span className="ml-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[14px] text-[var(--color-text-muted)]">{agentOverrideCount}</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("categories")}
          className={cn(
            "px-4 py-2 text-[16px] font-medium transition-colors cursor-pointer leading-[1.00]",
            activeTab === "categories"
              ? "border-b-2 border-[var(--color-text-muted)] text-[var(--color-text-main)]"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text-main)]"
          )}
        >
          Category Assignments
          {categoryOverrideCount > 0 && (
            <span className="ml-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[14px] text-[var(--color-text-muted)]">{categoryOverrideCount}</span>
          )}
        </button>
      </div>

      {/* Agent Assignments */}
      {activeTab === "agents" && (
        <div className="space-y-3 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-4 text-[var(--color-text-main)]">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[16px] font-bold text-[var(--color-text-main)]">Agent Model Assignments</p>
              <p className="text-[14px] text-[var(--color-text-muted)] mt-0.5 leading-[2.00]">
                Override which model each agent uses. Leave as "Auto" to use the default chain.
              </p>
            </div>
            {agentOverrideCount > 0 && (
              <span className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[14px] text-[var(--color-text-muted)]">{agentOverrideCount}/{Object.keys(agentRoles).length} custom</span>
            )}
          </div>
          
          <div className="space-y-2 mt-4">
            {Object.entries(agentRoles).map(([agent, label]) => (
              <ModelAssignmentRow
                key={agent}
                name={agent}
                label={label}
                currentModel={agentAssignments[agent]}
                isOverride={!!agentAssignments[agent]}
                onSelectClick={() => handleOpenModelSelect("agent", agent)}
                onClear={() => handleAgentModelChange(agent, undefined)}
              />
            ))}
          </div>

          {saving && (
            <p className="text-[14px] text-[var(--color-warning)]">Saving...</p>
          )}
        </div>
      )}

      {/* Category Assignments */}
      {activeTab === "categories" && (
        <div className="space-y-3 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-4 text-[var(--color-text-main)]">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[16px] font-bold text-[var(--color-text-main)]">Category Model Assignments</p>
              <p className="text-[14px] text-[var(--color-text-muted)] mt-0.5 leading-[2.00]">
                Override which model each task category uses. Leave as "Auto" to use the default chain.
              </p>
            </div>
            {categoryOverrideCount > 0 && (
              <span className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[14px] text-[var(--color-text-muted)]">{categoryOverrideCount}/{Object.keys(categoryRoles).length} custom</span>
            )}
          </div>
          
          <div className="space-y-2 mt-4">
            {Object.entries(categoryRoles).map(([category, label]) => (
              <ModelAssignmentRow
                key={category}
                name={category}
                label={label}
                currentModel={categoryAssignments[category]}
                isOverride={!!categoryAssignments[category]}
                onSelectClick={() => handleOpenModelSelect("category", category)}
                onClear={() => handleCategoryModelChange(category, undefined)}
              />
            ))}
          </div>

          {saving && (
            <p className="text-[14px] text-[var(--color-warning)]">Saving...</p>
          )}
        </div>
      )}

      {/* Help Text */}
      <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2 text-[14px] text-[var(--color-text-muted)] space-y-1">
        <p className="font-bold">💡 Tips:</p>
        <ul className="list-disc list-inside space-y-0.5 ml-2">
          <li>Use "Auto" to let the system choose the best model from the chain</li>
          <li>Override specific agents/categories when you need more control</li>
          <li>Model format: <code className="text-[var(--color-primary)]">cx/gpt-5.3-codex</code> (with provider prefix)</li>
          <li>Changes are saved automatically</li>
        </ul>
      </div>

      {/* Model Select Modal */}
      <ModelSelectModal
        isOpen={showModelSelect}
        onClose={() => { setShowModelSelect(false); setPendingAssignment(null); }}
        onSelect={handleModelSelected}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        title={pendingAssignment ? `Select model for ${pendingAssignment.key}` : "Select Model"}
      />
    </div>
  );
}
