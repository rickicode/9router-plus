"use client";

import { useState } from "react";
import { Badge, Button, Card, Input } from "@/shared/components";

export default function PluginsCard({ preferences, saving = false, error = "", onSave }) {
  const [plugin, setPlugin] = useState("");
  const plugins = preferences?.customPlugins || [];

  const addPlugin = () => {
    const nextPlugin = plugin.trim();
    if (!nextPlugin || plugins.includes(nextPlugin)) return;

    onSave?.({ customPlugins: [...plugins, nextPlugin] });
    setPlugin("");
  };

  return (
    <Card
      title="Plugins"
      subtitle="Include extra packages into your config."
      icon="extension"
      className="rounded border-[rgba(15,0,0,0.12)] bg-[#201d1d] font-['Berkeley_Mono'] text-[#fdfcfc]"
    >
      <div className="space-y-6 p-6">
        <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] px-5 py-[1.125rem]">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[16px] font-bold text-[#fdfcfc]">Plugin packages</p>
              <p className="text-[14px] leading-[2.00] text-[#9a9898]">Add only the extras you actually need so the generated setup stays lean.</p>
            </div>
            <span className="rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-3 py-1 text-[14px] font-bold text-[#ec4899]">{safePlugins.length} configured</span>
          </div>
        </div>

        <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] px-5 py-5">
          <div className="mb-4 space-y-1">
            <p className="text-[16px] font-bold text-[#fdfcfc]">Add a package</p>
            <p className="text-[14px] leading-[2.00] text-[#9a9898]">Keep plugin additions sparse so the generated setup stays readable.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <Input
              label="Package name"
              value={stagedPlugin}
              onChange={(event) => setStagedPlugin(event.target.value)}
              placeholder="e.g. opencode-plugin-name"
            />
            <div className="flex items-end">
              <button 
                className="w-full rounded bg-[#201d1d] px-[20px] py-[4px] text-[16px] font-medium leading-[2.00] text-[#fdfcfc] hover:bg-[#ec4899] transition-colors border border-[rgba(15,0,0,0.12)] cursor-pointer disabled:opacity-50"
                onClick={addPlugin} 
                disabled={!stagedPlugin.trim()}
              >
                Add package
              </button>
            </div>
          </div>
        </div>

        {error ? <p className="text-[14px] text-[#ff3b30]">{error}</p> : null}

        <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] p-4">
          <div className="mb-3.5 flex items-center justify-between gap-3">
            <p className="text-[16px] font-bold text-[#fdfcfc]">Current plugin list</p>
            <span className="rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-2 py-0.5 text-[14px] text-[#9a9898]">{safePlugins.length}</span>
          </div>
          <div className="flex min-h-[40px] flex-wrap gap-2.5">
            {safePlugins.length === 0 ? (
              <p className="text-[14px] text-[#9a9898]">No custom plugins added.</p>
            ) : (
              safePlugins.map((item) => (
                <span key={item} className="flex items-center gap-2 pr-1 rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-2 py-0.5 text-[14px] text-[#fdfcfc]">
                  <span className="max-w-[240px] truncate">{item}</span>
                  <button
                    type="button"
                    className="rounded-full p-0.5 hover:text-[#ff3b30] cursor-pointer"
                    onClick={() => removePlugin(item)}
                    aria-label={`Remove ${item}`}
                  >
                    <span className="material-symbols-outlined text-[14px]">close</span>
                  </button>
                </span>
              ))
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
