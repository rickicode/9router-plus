"use client";

import { useState } from "react";
import { Badge, Button, Card, Input } from "@/shared/components";

function formatDate(value) {
  if (!value) return "Never";

  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export default function TokenManagerCard({
  tokens = [],
  creating = false,
  createError = "",
  createdToken = "",
  onCreate,
}) {
  const [name, setName] = useState("My Token");
  const [showInstructions, setShowInstructions] = useState(false);

  return (
    <Card
      title="Auto-sync tokens"
      subtitle="Create tokens to enable automatic config sync from this dashboard."
      icon="vpn_key"
      className="rounded border-[rgba(15,0,0,0.12)] bg-[#201d1d] text-[#fdfcfc]"
    >
      <div className="space-y-6 p-6">
        <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] px-5 py-[1.125rem]">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[16px] font-bold text-[#fdfcfc] leading-[1.50]">Create a sync token</p>
              <p className="text-[14px] leading-[2.00] text-[#9a9898]">Tokens allow OpenCode to sync config from this dashboard automatically.</p>
            </div>
            <span className="rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-2 py-0.5 text-[14px] text-[#9a9898]">{tokens.length} active</span>
          </div>
        </div>

        <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] px-5 py-5">
          <div className="mb-4 space-y-1">
            <p className="text-[16px] font-bold text-[#fdfcfc]">Issue a new token</p>
            <p className="text-[14px] leading-[2.00] text-[#9a9898]">New token values are only shown once, so create them only when you are ready to copy.</p>
          </div>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <Input
              label="Token name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Production Server"
              hint="Give it a descriptive name to identify where it's used."
            />
            <div className="flex items-end">
              <button
                className="w-full rounded bg-[#201d1d] px-[20px] py-[4px] text-[16px] font-medium leading-[2.00] text-[#fdfcfc] hover:bg-[#ec4899] transition-colors border border-[rgba(15,0,0,0.12)] cursor-pointer disabled:opacity-50"
                onClick={() => onCreate?.({ name, mode: "shared" })}
                disabled={!name.trim() || creating}
              >
                {creating ? "Creating..." : "Create token"}
              </button>
            </div>
          </div>
        </div>

        {createError ? (
          <div className="rounded border border-[#ff3b30] bg-[#201d1d] px-4 py-3 text-[14px] text-[#ff3b30]">
            {createError}
          </div>
        ) : null}

        {createdToken ? (
          <div className="space-y-4">
            <div className="space-y-3 rounded border border-[#30d158]/20 bg-[#30d158]/10 px-5 py-[1.125rem]">
              <div className="flex items-center gap-2">
                <span className="rounded border border-[#30d158]/20 bg-[#30d158]/10 px-2 py-0.5 text-[14px] text-[#30d158]">New token</span>
                <span className="text-[14px] text-[#9a9898]">Shown once — copy it now.</span>
              </div>
              <code className="block overflow-x-auto rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-3 py-2 text-[14px] text-[#fdfcfc]">
                {createdToken}
              </code>
              <div className="rounded border border-[#ff9f0a]/20 bg-[#ff9f0a]/10 px-3 py-2 text-[14px] text-[#ff9f0a]">
                ⚠️ This token will not be shown again. Save it securely before closing this message.
              </div>
            </div>

            {/* Setup Instructions */}
            <div className="space-y-3 rounded border border-[#007aff]/20 bg-[#007aff]/10 px-5 py-[1.125rem]">
              <button
                type="button"
                onClick={() => setShowInstructions(!showInstructions)}
                className="flex w-full items-center justify-between text-left cursor-pointer"
              >
                <span className="text-[16px] font-bold text-[#007aff]">
                  📋 Setup Instructions
                </span>
                <span className="text-[#007aff]">
                  {showInstructions ? "▼" : "▶"}
                </span>
              </button>

              {showInstructions && (
                <div className="space-y-4 pt-2 text-[14px] text-[#fdfcfc]">
                  <div>
                    <p className="font-bold mb-2">1. Add to opencode.json plugin array:</p>
                    <code className="block rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-3 py-2 text-[14px] text-[#fdfcfc] overflow-x-auto">
                      "plugin": ["opencode-9router-sync@latest", ...]
                    </code>
                  </div>

                  <div>
                    <p className="font-bold mb-2">2. Create config file:</p>
                    
                    {/* Standard */}
                    <div className="mb-3 rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] p-3">
                      <p className="font-bold mb-1 text-[#fdfcfc]">Standard:</p>
                      <code className="block text-[14px] text-[#9a9898] mb-2">
                        ~/.config/opencode-9router-sync/config.json
                      </code>
                      <pre className="rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-3 py-2 text-[14px] text-[#fdfcfc] overflow-x-auto">
{`{
  "dashboardUrl": "${typeof window !== "undefined" ? window.location.origin : "http://localhost:20129"}",
  "syncToken": "${createdToken}",
  "lastKnownVersion": null
}`}
                      </pre>
                    </div>

                    {/* OCX Profile */}
                    <div className="rounded border border-[#30d158]/20 bg-[#30d158]/10 p-3">
                      <p className="font-bold mb-1 text-[#30d158]">With OCX Profile:</p>
                      <code className="block text-[14px] text-[#30d158] mb-2">
                        ~/.config/opencode/profiles/&lt;profilename&gt;/opencode-9router-sync/config.json
                      </code>
                      <pre className="rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-3 py-2 text-[14px] text-[#fdfcfc] overflow-x-auto">
{`{
  "dashboardUrl": "${typeof window !== "undefined" ? window.location.origin : "http://localhost:20129"}",
  "syncToken": "${createdToken}",
  "lastKnownVersion": null
}`}
                      </pre>
                    </div>
                  </div>

                  <div className="rounded border border-[#007aff]/20 bg-[#007aff]/10 px-3 py-2">
                    <p className="text-[#007aff]">
                      ✨ <strong>Auto-sync:</strong> The plugin will automatically sync your config from 9Router dashboard on OpenCode startup.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : null}

        <div className="space-y-4">
          {tokens.length === 0 ? (
            <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-5 py-6 text-[14px] text-[#9a9898]">
              No auto-sync tokens created yet.
            </div>
          ) : (
            tokens.map((token) => (
              <div key={token.id} className="space-y-4 rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] px-5 py-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-[16px] font-bold text-[#fdfcfc]">{token.name}</div>
                    <div className="mt-1 text-[14px] text-[#9a9898]">Created {formatDate(token.createdAt)}</div>
                  </div>
                </div>
                {token.metadata && Object.keys(token.metadata).length > 0 ? (
                  <pre className="overflow-x-auto rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-3 py-2 text-[14px] text-[#9a9898]">
                    {JSON.stringify(token.metadata, null, 2)}
                  </pre>
                ) : null}
                <div className="text-[14px] text-[#9a9898]">Last used: {formatDate(token.lastUsedAt)}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </Card>
  );
}
