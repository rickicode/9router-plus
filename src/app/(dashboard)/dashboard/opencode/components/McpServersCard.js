"use client";

import { useState } from "react";
import { Badge, Button, Card, Input, Select } from "@/shared/components";

function createEmptyServer() {
  return {
    name: "",
    type: "local",
    command: "",
    args: "",
    url: "",
  };
}

function toStoredServer(draft) {
  if (draft.type === "remote") {
    return {
      name: draft.name.trim(),
      type: "remote",
      url: draft.url.trim(),
    };
  }

  return {
    name: draft.name.trim(),
    type: "local",
    command: [draft.command.trim(), ...draft.args.split(",").map((item) => item.trim()).filter(Boolean)].filter(Boolean),
  };
}

function fromStoredServer(server) {
  const command = Array.isArray(server?.command) ? server.command : [];
  return {
    name: server?.name || "",
    type: server?.type === "remote" ? "remote" : "local",
    command: command[0] || "",
    args: command.slice(1).join(", "),
    url: server?.url || "",
  };
}

export default function McpServersCard({ preferences, saving = false, error = "", onSave }) {
  const [draft, setDraft] = useState(createEmptyServer());
  const [draftServers, setDraftServers] = useState(() =>
    (preferences?.mcpServers || []).map((server) => fromStoredServer(server))
  );
  const [localError, setLocalError] = useState("");

  const validateServer = (server) => {
    if (!server?.name?.trim()) return "Server name is required";
    if (server.type === "remote" && !server.url?.trim()) return `Remote MCP server "${server.name.trim()}" requires a URL`;
    if (server.type !== "remote" && !server.command?.trim()) return `Local MCP server "${server.name.trim()}" requires a command`;
    return "";
  };

  const addServer = () => {
    const validationError = validateServer(draft);
    if (validationError) {
      setLocalError(validationError);
      return;
    }

    setDraftServers((current) => [...current, draft]);
    setDraft(createEmptyServer());
    setLocalError("");
  };

  const updateDraftServer = (index, patch) => {
    setDraftServers((current) =>
      current.map((item, currentIndex) => (currentIndex === index ? { ...item, ...patch } : item))
    );
  };

  const removeDraftServer = (index) => {
    setDraftServers((current) => current.filter((_, currentIndex) => currentIndex !== index));
  };

  const saveServers = () => {
    const firstInvalid = draftServers.find((server) => validateServer(server));
    if (firstInvalid) {
      setLocalError(validateServer(firstInvalid));
      return;
    }

    setLocalError("");

    onSave?.({
      mcpServers: draftServers
        .filter((server) => server.name.trim())
        .map((server) => toStoredServer(server)),
    });
  };

  return (
    <Card
      title="MCP servers"
      subtitle="Connect extra capability endpoints directly via config file."
      icon="dns"
      className="rounded border-[rgba(15,0,0,0.12)] bg-[#201d1d] font-['Berkeley_Mono'] text-[#fdfcfc]"
    >
      <div className="space-y-6 p-6">
        <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] px-5 py-[1.125rem]">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[16px] font-bold text-[#fdfcfc]">Connected MCP endpoints</p>
              <p className="text-[14px] leading-[2.00] text-[#9a9898]">Mix local command runners and remote URLs without overcrowding the main setup flow.</p>
            </div>
            <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-3 py-1 text-[14px] font-bold text-[#ec4899]">
              {safeServers.length} configured
            </div>
          </div>
        </div>

        <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] px-5 py-5">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <p className="text-[16px] font-bold text-[#fdfcfc]">Add a server</p>
              <p className="mt-1 text-[14px] leading-[2.00] text-[#9a9898]">Create the next MCP entry, then save the whole list once it feels complete.</p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Input
              label="Name"
              value={stagedServer.name}
              onChange={(event) => setStagedServer((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="server-name"
            />
            <Select
              label="Type"
              value={stagedServer.type}
              onChange={(event) => setStagedServer((prev) => ({ ...prev, type: event.target.value }))}
              options={Object.entries(SERVER_TYPES).map(([val, label]) => ({ value: val, label }))}
            />

            {stagedServer.type === "local" ? (
              <Input
                label="Command"
                value={stagedServer.command}
                onChange={(event) => setStagedServer((prev) => ({ ...prev, command: event.target.value }))}
                placeholder="npx"
                className="md:col-span-2"
                hint="For npx commands with arguments, format carefully to match the generated spec."
              />
            ) : (
              <Input
                label="URL"
                value={stagedServer.url}
                onChange={(event) => setStagedServer((prev) => ({ ...prev, url: event.target.value }))}
                placeholder="http://localhost:8080/sse"
                className="md:col-span-2"
                type="url"
              />
            )}
          </div>

          <div className="mt-5 flex justify-end">
            <button 
              className="rounded bg-[#201d1d] px-[20px] py-[4px] text-[16px] font-medium leading-[2.00] text-[#fdfcfc] hover:bg-[#ec4899] transition-colors border border-[rgba(15,0,0,0.12)] cursor-pointer"
              onClick={stageServer}
            >
              Stage server
            </button>
          </div>
        </div>

        {error ? <p className="text-[14px] text-[#ff3b30]">{error}</p> : null}
        {localError ? <p className="text-[14px] text-[#ff3b30]">{localError}</p> : null}

        <div className="space-y-4">
          {safeServers.length === 0 ? (
            <div className="rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] px-5 py-6 text-[14px] text-[#9a9898]">No MCP servers configured yet.</div>
          ) : (
            safeServers.map((draftServer, index) => {
              const safeType = Object.keys(SERVER_TYPES).includes(draftServer.type) ? draftServer.type : "local";
              const typeLabel = SERVER_TYPES[safeType];

              return (
                <div key={`${draftServer.name || "server"}-${index}`} className="space-y-5 rounded border border-[rgba(15,0,0,0.12)] bg-[#302c2c] px-5 py-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[16px] font-bold text-[#fdfcfc]">{draftServer.name || `Server ${index + 1}`}</div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[14px] text-[#9a9898]">
                        <span className="font-bold uppercase tracking-[0.14em]">{typeLabel}</span>
                        <span className="inline-block h-1 w-1 rounded-full bg-[#9a9898]/50" />
                        <span className="truncate">{draftServer.disabled ? "Disabled" : "Active"}</span>
                      </div>
                    </div>
                    <button 
                      className="rounded bg-transparent px-[12px] py-[4px] text-[14px] font-medium leading-[2.00] text-[#ff3b30] hover:bg-[#201d1d] transition-colors border border-transparent hover:border-[#ff3b30] cursor-pointer"
                      onClick={() => removeServer(index)}
                    >
                      Remove
                    </button>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <Input
                      label="Name"
                      value={draftServer.name || ""}
                      onChange={(event) => updateServer(index, "name", event.target.value)}
                    />
                    <Select
                      label="Type"
                      value={safeType}
                      onChange={(event) => updateServer(index, "type", event.target.value)}
                      options={Object.entries(SERVER_TYPES).map(([val, label]) => ({ value: val, label }))}
                    />

                    {safeType === "local" ? (
                      <Input
                        label="Command"
                        value={draftServer.command || ""}
                        onChange={(event) => updateServer(index, "command", event.target.value)}
                        className="md:col-span-2"
                      />
                    ) : (
                      <Input
                        label="URL"
                        value={draftServer.url || ""}
                        onChange={(event) => updateServer(index, "url", event.target.value)}
                        className="md:col-span-2"
                      />
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </Card>
  );
}
