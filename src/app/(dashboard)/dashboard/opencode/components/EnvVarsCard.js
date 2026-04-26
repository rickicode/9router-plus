"use client";

import { useState } from "react";
import { Button, Card, Input, Toggle } from "@/shared/components";

function createEmptyEnvVar() {
  return {
    key: "",
    value: "",
    secret: true,
  };
}

export default function EnvVarsCard({ preferences, saving = false, error = "", onSave }) {
  const [draftVars, setDraftVars] = useState(() =>
    (preferences?.envVars || []).map((item) => ({
      key: item.key || "",
      value: item.secret ? "" : item.value || "",
      secret: item.secret === true,
      masked: item.secret === true,
    }))
  );
  const [localError, setLocalError] = useState("");

  const updateItem = (index, patch) => {
    setDraftVars((current) => current.map((item, currentIndex) => (currentIndex === index ? { ...item, ...patch } : item)));
  };

  const addRow = () => {
    setDraftVars((current) => [...current, createEmptyEnvVar()]);
  };

  const removeRow = (index) => {
    const nextVars = draftVars.filter((_, currentIndex) => currentIndex !== index);
    setDraftVars(nextVars);
  };

  const handleSave = () => {
    const hasHiddenValue = draftVars.some(
      (item) => item.key.trim() && item.masked && !item.value
    );

    if (hasHiddenValue) {
      setLocalError("Re-enter masked values before saving, or remove those rows.");
      return;
    }

    setLocalError("");

    const payload = draftVars
      .filter((item) => item.key.trim())
      .map(({ masked, ...item }) => ({
        key: item.key.trim(),
        value: item.value,
        secret: item.secret === true,
      }));

    onSave?.({ envVars: payload });
  };

  return (
    <Card
      title="Environment variables"
      subtitle="Pass secrets securely directly into the configuration block."
      icon="key"
      className="rounded border-[rgba(15,0,0,0.12)] bg-[#201d1d] font-['Berkeley_Mono'] text-[#fdfcfc]"
    >
      <div className="space-y-6 p-6">
        <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] px-5 py-[1.125rem]">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[16px] font-bold text-[#fdfcfc]">Config-backed variables</p>
              <p className="text-[14px] leading-[2.00] text-[#9a9898]">Secrets remain masked in the UI and should be re-entered before saving changes.</p>
            </div>
            <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-3 py-1 text-[14px] font-bold text-[#ec4899]">
              {safeEnv.length} configured
            </div>
          </div>
        </div>

        {error ? <p className="text-[14px] text-[#ff3b30]">{error}</p> : null}
        {localError ? <p className="text-[14px] text-[#ff3b30]">{localError}</p> : null}

        <div className="space-y-4">
          {safeEnv.length === 0 ? (
            <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] px-5 py-6 text-[14px] text-[#9a9898]">No environment variables configured yet.</div>
          ) : (
            safeEnv.map((item, index) => (
              <div key={`${item.key || "env"}-${index}`} className="space-y-5 rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] px-5 py-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[16px] font-bold text-[#fdfcfc]">Variable {index + 1}</p>
                    <p className="mt-1 text-[14px] leading-[2.00] text-[#9a9898]">{item.secret ? "Stored as a secret" : "Stored as plain text in preview"}</p>
                  </div>
                  <button 
                    className="rounded bg-transparent px-[12px] py-[4px] text-[14px] font-medium leading-[2.00] text-[#ff3b30] hover:bg-[#201d1d] transition-colors border border-transparent hover:border-[#ff3b30] cursor-pointer"
                    onClick={() => removeEnv(index)}
                  >
                    Remove
                  </button>
                </div>

                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <Input
                    label="Key"
                    value={item.key || ""}
                    onChange={(event) => updateEnv(index, "key", event.target.value)}
                    placeholder="VARIABLE_NAME"
                  />
                  <div className="space-y-3">
                    <Input
                      label="Value"
                      value={item.value || ""}
                      onChange={(event) => updateEnv(index, "value", event.target.value)}
                      placeholder="Value"
                      type={item.secret && !dirtyFlags.has(index) ? "password" : "text"}
                    />
                    <label className="flex items-center gap-2 cursor-pointer pl-1 text-[14px] text-[#9a9898]">
                      <input
                        type="checkbox"
                        checked={item.secret || false}
                        onChange={(event) => updateEnv(index, "secret", event.target.checked)}
                        className="rounded border-[rgba(15,0,0,0.12)] text-[#ec4899] focus:ring-[#ec4899]"
                      />
                      <span>Secret</span>
                    </label>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="flex justify-start pt-1">
          <button 
            className="rounded bg-[#201d1d] px-[20px] py-[4px] text-[16px] font-medium leading-[2.00] text-[#fdfcfc] hover:bg-[#ec4899] transition-colors border border-[rgba(15,0,0,0.12)] cursor-pointer"
            onClick={addEnv}
          >
            Add variable
          </button>
        </div>
      </div>
    </Card>
  );
}
