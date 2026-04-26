"use client";

import { useState, useMemo } from "react";
import { Badge, Button, Select } from "@/shared/components";
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

function ModelAssignmentRow({ name, label, currentModel, availableModels, isOverride, onModelChange, onClear }) {
  return (
    <div className="flex flex-col gap-2 rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] p-2.5 sm:flex-row sm:items-center sm:justify-between text-[#fdfcfc]">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-[14px] font-bold text-[#fdfcfc]">{name}</p>
          {isOverride && (
            <span className="rounded border border-[rgba(15,0,0,0.12)] bg-[#ec4899]/10 px-2 py-0.5 text-[12px] text-[#ec4899]">Custom</span>
          )}
        </div>
        <p className="truncate text-[12px] text-[#9a9898]">{label}</p>
      </div>
      <div className="flex items-center gap-2">
        <select
          value={currentModel || ""}
          onChange={(e) => onModelChange(e.target.value || undefined)}
          className="rounded border border-[rgba(15,0,0,0.12)] bg-[#f8f7f7] px-3 py-2 text-[14px] text-[#201d1d] focus:outline-none focus:ring-1 focus:ring-[#ec4899]"
        >
          <option value="">Auto (from chain)</option>
          {availableModels.map(id => (
            <option key={id} value={id}>{id}</option>
          ))}
        </select>
        {isOverride && (
          <button
            type="button"
            onClick={onClear}
            className="rounded p-1 text-[#9a9898] hover:text-[#ff3b30] transition-colors cursor-pointer"
            title="Clear override"
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        )}
      </div>
    </div>
  );
}

export default function AdvancedConfigEditor({ variant, preferences, availableModels, onSave, saving }) {
  const [activeTab, setActiveTab] = useState("agents");
  
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

  const agentOverrideCount = Object.keys(agentAssignments).length;
  const categoryOverrideCount = Object.keys(categoryAssignments).length;

  return (
    <div className="space-y-4">
      {/* Tab Navigation */}
      <div className="flex items-center gap-2 border-b border-[rgba(15,0,0,0.12)]">
        <button
          type="button"
          onClick={() => setActiveTab("agents")}
          className={cn(
            "px-4 py-2 text-[16px] font-medium transition-colors cursor-pointer leading-[1.00]",
            activeTab === "agents"
              ? "border-b-2 border-[#9a9898] text-[#fdfcfc]"
              : "text-[#9a9898] hover:text-[#fdfcfc]"
          )}
        >
          Agent Assignments
          {agentOverrideCount > 0 && (
            <span className="ml-2 rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-2 py-0.5 text-[14px] text-[#9a9898]">{agentOverrideCount}</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("categories")}
          className={cn(
            "px-4 py-2 text-[16px] font-medium transition-colors cursor-pointer leading-[1.00]",
            activeTab === "categories"
              ? "border-b-2 border-[#9a9898] text-[#fdfcfc]"
              : "text-[#9a9898] hover:text-[#fdfcfc]"
          )}
        >
          Category Assignments
          {categoryOverrideCount > 0 && (
            <span className="ml-2 rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-2 py-0.5 text-[14px] text-[#9a9898]">{categoryOverrideCount}</span>
          )}
        </button>
      </div>

      {/* Agent Assignments */}
      {activeTab === "agents" && (
        <div className="space-y-3 rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] p-4 text-[#fdfcfc]">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[16px] font-bold text-[#fdfcfc]">Agent Model Assignments</p>
              <p className="text-[14px] text-[#9a9898] mt-0.5 leading-[2.00]">
                Override which model each agent uses. Leave as "Auto" to use the default chain.
              </p>
            </div>
            {agentOverrideCount > 0 && (
              <span className="rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-2 py-0.5 text-[14px] text-[#9a9898]">{agentOverrideCount}/{Object.keys(agentRoles).length} custom</span>
            )}
          </div>
          
          <div className="space-y-2 mt-4">
            {Object.entries(agentRoles).map(([agent, label]) => (
              <ModelAssignmentRow
                key={agent}
                name={agent}
                label={label}
                currentModel={agentAssignments[agent]}
                availableModels={availableModels}
                isOverride={!!agentAssignments[agent]}
                onModelChange={(model) => handleAgentModelChange(agent, model)}
                onClear={() => handleAgentModelChange(agent, undefined)}
              />
            ))}
          </div>

          {saving && (
            <p className="text-[14px] text-[#ff9f0a]">Saving...</p>
          )}
        </div>
      )}

      {/* Category Assignments */}
      {activeTab === "categories" && (
        <div className="space-y-3 rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] p-4 text-[#fdfcfc]">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[16px] font-bold text-[#fdfcfc]">Category Model Assignments</p>
              <p className="text-[14px] text-[#9a9898] mt-0.5 leading-[2.00]">
                Override which model each task category uses. Leave as "Auto" to use the default chain.
              </p>
            </div>
            {categoryOverrideCount > 0 && (
              <span className="rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-2 py-0.5 text-[14px] text-[#9a9898]">{categoryOverrideCount}/{Object.keys(categoryRoles).length} custom</span>
            )}
          </div>
          
          <div className="space-y-2 mt-4">
            {Object.entries(categoryRoles).map(([category, label]) => (
              <ModelAssignmentRow
                key={category}
                name={category}
                label={label}
                currentModel={categoryAssignments[category]}
                availableModels={availableModels}
                isOverride={!!categoryAssignments[category]}
                onModelChange={(model) => handleCategoryModelChange(category, model)}
                onClear={() => handleCategoryModelChange(category, undefined)}
              />
            ))}
          </div>

          {saving && (
            <p className="text-[14px] text-[#ff9f0a]">Saving...</p>
          )}
        </div>
      )}

      {/* Help Text */}
      <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] px-3 py-2 text-[14px] text-[#9a9898] space-y-1">
        <p className="font-bold">💡 Tips:</p>
        <ul className="list-disc list-inside space-y-0.5 ml-2">
          <li>Use "Auto" to let the system choose the best model from the chain</li>
          <li>Override specific agents/categories when you need more control</li>
          <li>Model format: <code className="text-[#ec4899]">cx/gpt-5.3-codex</code> (with provider prefix)</li>
          <li>Changes are saved automatically</li>
        </ul>
      </div>
    </div>
  );
}
