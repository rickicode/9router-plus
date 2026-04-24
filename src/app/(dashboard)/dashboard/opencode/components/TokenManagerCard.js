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
      className="rounded border-border"
    >
      <div className="space-y-6">
        <div className="rounded border border-primary/10 bg-[var(--color-primary-soft)] px-5 py-[1.125rem]">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-text-main">Create a sync token</p>
              <p className="text-xs leading-5 text-text-muted">Tokens allow OpenCode to sync config from this dashboard automatically.</p>
            </div>
            <Badge size="sm">{tokens.length} active</Badge>
          </div>
        </div>

        <Card.Section className="rounded border border-border bg-[var(--color-surface)] px-5 py-5">
          <div className="mb-4 space-y-1">
            <p className="text-sm font-semibold text-text-main">Issue a new token</p>
            <p className="text-xs leading-5 text-text-muted">New token values are only shown once, so create them only when you are ready to copy.</p>
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
              <Button
                fullWidth
                loading={creating}
                onClick={() => onCreate?.({ name, mode: "shared" })}
                disabled={!name.trim()}
              >
                Create token
              </Button>
            </div>
          </div>
        </Card.Section>

        {createError ? (
          <div className="rounded border border-[var(--color-danger)]/20 bg-[var(--color-danger-soft)] px-4 py-3 text-sm text-[var(--color-danger)]">
            {createError}
          </div>
        ) : null}

        {createdToken ? (
          <div className="space-y-4">
            <Card.Section className="space-y-3 rounded border border-[var(--color-success)]/20 bg-[var(--color-success-soft)] px-5 py-[1.125rem]">
              <div className="flex items-center gap-2">
                <Badge variant="success">New token</Badge>
                <span className="text-xs text-text-muted">Shown once — copy it now.</span>
              </div>
              <code className="block overflow-x-auto rounded bg-[var(--color-editor-bg)] px-3 py-2 text-xs text-[var(--color-text-inverse)]">
                {createdToken}
              </code>
              <div className="rounded border border-[var(--color-warning)]/20 bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-warning)]">
                ⚠️ This token will not be shown again. Save it securely before closing this message.
              </div>
            </Card.Section>

            {/* Setup Instructions */}
            <Card.Section className="space-y-3 rounded border border-[var(--color-info)]/20 bg-[var(--color-info-soft)] px-5 py-[1.125rem]">
              <button
                type="button"
                onClick={() => setShowInstructions(!showInstructions)}
                className="flex w-full items-center justify-between text-left"
              >
                <span className="text-sm font-semibold text-[var(--color-info)]">
                  📋 Setup Instructions
                </span>
                <span className="text-[var(--color-info)]">
                  {showInstructions ? "▼" : "▶"}
                </span>
              </button>

              {showInstructions && (
                <div className="space-y-4 pt-2 text-xs text-[var(--color-text-main)]">
                  <div>
                    <p className="font-semibold mb-2">1. Add to opencode.json plugin array:</p>
                    <code className="block rounded bg-[var(--color-editor-bg)] px-3 py-2 text-xs text-[var(--color-text-inverse)] overflow-x-auto">
                      "plugin": ["opencode-9router-sync@latest", ...]
                    </code>
                  </div>

                  <div>
                    <p className="font-semibold mb-2">2. Create config file:</p>
                    
                    {/* Standard */}
                    <div className="mb-3 rounded border border-border bg-[var(--color-bg-alt)] p-3">
                      <p className="font-semibold mb-1 text-[var(--color-text-main)]">Standard:</p>
                      <code className="block text-[10px] text-[var(--color-text-muted)] mb-2">
                        ~/.config/opencode-9router-sync/config.json
                      </code>
                      <pre className="rounded bg-[var(--color-editor-bg)] px-3 py-2 text-[10px] text-[var(--color-text-inverse)] overflow-x-auto">
{`{
  "dashboardUrl": "${typeof window !== "undefined" ? window.location.origin : "http://localhost:20129"}",
  "syncToken": "${createdToken}",
  "lastKnownVersion": null
}`}
                      </pre>
                    </div>

                    {/* OCX Profile */}
                    <div className="rounded border border-[var(--color-success)]/20 bg-[var(--color-success-soft)] p-3">
                      <p className="font-semibold mb-1 text-[var(--color-success)]">With OCX Profile:</p>
                      <code className="block text-[10px] text-[var(--color-success)] mb-2">
                        ~/.config/opencode/profiles/&lt;profilename&gt;/opencode-9router-sync/config.json
                      </code>
                      <pre className="rounded bg-[var(--color-editor-bg)] px-3 py-2 text-[10px] text-[var(--color-text-inverse)] overflow-x-auto">
{`{
  "dashboardUrl": "${typeof window !== "undefined" ? window.location.origin : "http://localhost:20129"}",
  "syncToken": "${createdToken}",
  "lastKnownVersion": null
}`}
                      </pre>
                    </div>
                  </div>

                  <div className="rounded border border-[var(--color-info)]/20 bg-[var(--color-info-soft)] px-3 py-2">
                    <p className="text-[var(--color-info)]">
                      ✨ <strong>Auto-sync:</strong> The plugin will automatically sync your config from 9Router dashboard on OpenCode startup.
                    </p>
                  </div>
                </div>
              )}
            </Card.Section>
          </div>
        ) : null}

        <div className="space-y-4">
          {tokens.length === 0 ? (
            <div className="rounded border border-dashed border-border bg-[var(--color-bg-alt)] px-5 py-6 text-sm text-text-muted">
              No auto-sync tokens created yet.
            </div>
          ) : (
            tokens.map((token) => (
              <Card.Section key={token.id} className="space-y-4 rounded border border-border bg-[var(--color-surface)] px-5 py-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-text-main">{token.name}</div>
                    <div className="mt-1 text-xs text-text-muted">Created {formatDate(token.createdAt)}</div>
                  </div>
                </div>
                {token.metadata && Object.keys(token.metadata).length > 0 ? (
                  <pre className="overflow-x-auto rounded bg-[var(--color-bg-alt)] px-3 py-2 text-xs text-text-muted">
                    {JSON.stringify(token.metadata, null, 2)}
                  </pre>
                ) : null}
                <div className="text-xs text-text-muted">Last used: {formatDate(token.lastUsedAt)}</div>
              </Card.Section>
            ))
          )}
        </div>
      </div>
    </Card>
  );
}
