import { execSync } from "node:child_process";

import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { resolveCommandCodeInstructionsForRequest } from "../../config/commandcodeInstructionsResolver.js";

function normalizeToolChoice(toolChoice) {
  if (!toolChoice || toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "none") return { type: "none" };
  if (toolChoice === "required") return { type: "any" };
  if (typeof toolChoice === "string") return { type: "tool", name: toolChoice };
  if (toolChoice?.type === "function") {
    return {
      type: "tool",
      name: toolChoice.function?.name || toolChoice.name || "",
    };
  }
  return toolChoice;
}

function normalizeCommandCodeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  return tools.map((tool) => {
    if (tool?.name && tool?.input_schema) {
      return {
        name: tool.name,
        description: tool.description || "",
        input_schema: tool.input_schema || { type: "object", properties: {} },
      };
    }

    const toolType = tool?.type;
    if (toolType && toolType !== "function") return tool;

    const toolData = toolType === "function" && tool.function ? tool.function : tool;
    return {
      name: toolData?.name || "",
      description: toolData?.description || "",
      input_schema: toolData?.parameters || toolData?.input_schema || { type: "object", properties: {} },
    };
  }).filter((tool) => tool?.name || tool?.type);
}

function getMessageTextContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function hasExplicitInstructionMessages(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((msg) => {
    if (!msg || (msg.role !== "system" && msg.role !== "developer")) return false;
    return Boolean(getMessageTextContent(msg.content));
  });
}

function collectInstructionText(messages, injectedInstructionText = "") {
  const blocks = [];

  if (typeof injectedInstructionText === "string" && injectedInstructionText.trim()) {
    blocks.push(injectedInstructionText.trim());
  }

  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || (msg.role !== "system" && msg.role !== "developer")) continue;
      const text = getMessageTextContent(msg.content);
      if (text) blocks.push(text);
    }
  }

  return blocks.join("\n\n").trim();
}

function normalizeToolResultOutput(content) {
  if (typeof content === "string") {
    return { type: "text", value: content };
  }

  if (!Array.isArray(content)) {
    if (content && typeof content === "object") {
      try {
        return { type: "json", value: JSON.stringify(content) };
      } catch {
        return { type: "text", value: "" };
      }
    }
    return { type: "text", value: "" };
  }

  const textParts = [];
  const imageParts = [];

  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      textParts.push(part.text);
      continue;
    }
    if (part.type === "image" && part.source) {
      imageParts.push({ type: "image", source: part.source });
      continue;
    }
    if (part.type === "image_url" && part.image_url?.url) {
      imageParts.push({ type: "image", image: part.image_url.url });
    }
  }

  if (imageParts.length > 0) {
    return {
      type: "json",
      value: JSON.stringify({ text: textParts.join("\n\n"), images: imageParts }),
    };
  }

  return { type: "text", value: textParts.join("\n\n") };
}

function normalizeUserContent(content) {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;

    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }

    if (part.type === "tool_result") {
      blocks.push({
        type: "tool-result",
        toolCallId: part.tool_use_id || part.toolCallId || part.id || "",
        toolName: part.toolName || part.name || "tool",
        output: normalizeToolResultOutput(part.content),
        ...(part.is_error ? { isError: true } : {}),
      });
      continue;
    }

    if (part.type === "image" && part.source) {
      blocks.push({ type: "image", source: part.source });
      continue;
    }

    if (part.type === "image_url" && part.image_url?.url) {
      blocks.push({ type: "image", image: part.image_url.url });
    }
  }

  return blocks;
}

function normalizeAssistantContent(msg) {
  const blocks = [];

  if (typeof msg.content === "string" && msg.content) {
    blocks.push({ type: "text", text: msg.content });
  }

  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;

      if (part.type === "text" && typeof part.text === "string") {
        blocks.push({ type: "text", text: part.text });
        continue;
      }

      if (part.type === "tool_use") {
        blocks.push({
          type: "tool-call",
          toolCallId: part.id || part.toolCallId || "",
          toolName: part.name || part.toolName || "tool",
          input: part.input || {},
        });
      }
    }
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const toolCall of msg.tool_calls) {
      const input = typeof toolCall?.function?.arguments === "string"
        ? safeJsonParse(toolCall.function.arguments)
        : (toolCall?.function?.arguments || {});
      blocks.push({
        type: "tool-call",
        toolCallId: toolCall?.id || "",
        toolName: toolCall?.function?.name || toolCall?.name || "tool",
        input,
      });
    }
  }

  return blocks;
}

function safeJsonParse(value) {
  if (typeof value !== "string") return value || {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function findAssistantToolCall(messages, toolCallId) {
  if (!Array.isArray(messages) || !toolCallId) return null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages[index];
    if (msg?.role !== "assistant") continue;

    if (Array.isArray(msg.tool_calls)) {
      const match = msg.tool_calls.find((toolCall) => toolCall?.id === toolCallId);
      if (match) {
        return {
          toolCallId,
          toolName: match?.function?.name || match?.name || "tool",
        };
      }
    }

    if (Array.isArray(msg.content)) {
      const match = msg.content.find((part) => part?.type === "tool_use" && (part.id || part.toolCallId) === toolCallId);
      if (match) {
        return {
          toolCallId,
          toolName: match?.name || match?.toolName || "tool",
        };
      }
    }
  }

  return null;
}

function normalizeCommandCodeMessages(messages) {
  if (!Array.isArray(messages)) return [];

  const normalized = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "system" || msg.role === "developer") continue;

    if (msg.role === "user") {
      const content = normalizeUserContent(msg.content);
      if (content.length > 0) normalized.push({ role: "user", content });
      continue;
    }

    if (msg.role === "assistant") {
      const content = normalizeAssistantContent(msg);
      if (content.length > 0) normalized.push({ role: "assistant", content });
      continue;
    }

    if (msg.role === "tool") {
      const toolCallId = msg.tool_call_id || msg.toolCallId || msg.id || "";
      const toolRef = findAssistantToolCall(messages, toolCallId);
      normalized.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId,
          toolName: msg.tool_name || msg.toolName || msg.name || toolRef?.toolName || "tool",
          output: normalizeToolResultOutput(msg.content),
          ...(msg.is_error ? { isError: true } : {}),
        }],
      });
    }
  }

  return normalized.filter((message, index, all) => {
    if (message?.role !== "tool") return true;
    const item = message.content?.[0];
    if (item?.type !== "tool-result") return true;
    const value = item.output?.value || "";
    if (value) return true;

    return !all.some((other, otherIndex) => {
      if (otherIndex === index || other?.role !== "tool") return false;
      const otherItem = other.content?.[0];
      return otherItem?.type === "tool-result"
        && otherItem.toolCallId === item.toolCallId
        && (otherItem.output?.value || "") !== "";
    });
  });
}

function getProjectSlug() {
  const cwd = process.cwd();
  return cwd
    .replace(/^\/+/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "workspace";
}

function getGitOutput(command) {
  try {
    return execSync(command, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function getWorkspaceStructure() {
  try {
    return execSync("find . -maxdepth 1 -mindepth 1 -type d | sed 's#^./##' | sort", {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getCommandCodeRepoContext() {
  const workingDir = process.cwd();
  const gitRoot = getGitOutput("git rev-parse --show-toplevel");
  const isGitRepo = Boolean(gitRoot);
  const currentBranch = isGitRepo ? getGitOutput("git branch --show-current") : "";
  const mainBranch = isGitRepo
    ? (getGitOutput("git symbolic-ref --short refs/remotes/origin/HEAD").split("/").pop() || "main")
    : "";
  const gitStatus = isGitRepo
    ? (() => {
        const modified = getGitOutput("git status --short | wc -l | tr -d ' '");
        const deleted = getGitOutput("git status --short | awk '$1 ~ /D/ || $2 ~ /D/ {count++} END {print count+0}'");
        const untracked = getGitOutput("git status --short | awk '$1 ~ /\?\?/ {count++} END {print count+0}'");
        return `M ${modified || 0}, D ${deleted || 0}, ?? ${untracked || 0}`;
      })()
    : "";
  const recentCommits = isGitRepo
    ? getGitOutput("git log --oneline -3").split("\n").filter(Boolean)
    : [];

  return {
    workingDir,
    structure: getWorkspaceStructure(),
    isGitRepo,
    currentBranch,
    mainBranch,
    gitStatus,
    recentCommits,
  };
}

function buildCommandCodeConfig() {
  const repoContext = getCommandCodeRepoContext();
  return {
    workingDir: repoContext.workingDir,
    date: new Date().toISOString().split("T")[0],
    environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
    structure: repoContext.structure,
    isGitRepo: repoContext.isGitRepo,
    currentBranch: repoContext.currentBranch,
    mainBranch: repoContext.mainBranch,
    gitStatus: repoContext.gitStatus,
    recentCommits: repoContext.recentCommits,
  };
}

async function openaiToCommandCode(model, body, stream) {
  const sourceMessages = Array.isArray(body.messages) ? body.messages : [];
  const shouldInjectDefaultInstructions = !hasExplicitInstructionMessages(sourceMessages);
  const defaultInstructions = shouldInjectDefaultInstructions
    ? await resolveCommandCodeInstructionsForRequest()
    : "";

  const systemPrompt = collectInstructionText(sourceMessages, defaultInstructions);
  const messages = normalizeCommandCodeMessages(sourceMessages);
  const normalizedTools = normalizeCommandCodeTools(body.tools);
  const params = {
    stream,
    messages,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
    ...(typeof body.max_tokens === "number" ? { max_tokens: body.max_tokens } : {}),
    ...(normalizedTools?.length ? { tools: normalizedTools } : {}),
    toolChoice: normalizeToolChoice(body.tool_choice),
    model,
  };

  if (typeof body.presence_penalty === "number") params.presence_penalty = body.presence_penalty;
  if (typeof body.frequency_penalty === "number") params.frequency_penalty = body.frequency_penalty;
  if (body.response_format !== undefined) params.response_format = body.response_format;
  if (typeof body.parallel_tool_calls === "boolean") params.parallel_tool_calls = body.parallel_tool_calls;
  if (body.stop !== undefined) params.stop = body.stop;

  const config = buildCommandCodeConfig();

  const result = {
    model,
    config,
    memory: typeof body.memory === "string" ? body.memory : null,
    params,
    ...(body.threadId ? { threadId: body.threadId } : {}),
    ...(body.mode ? { mode: body.mode } : {}),
    ...(body.taste ? { taste: body.taste } : {}),
    ...(body.skills ? { skills: body.skills } : {}),
    ...(body.permissionMode ? { permissionMode: body.permissionMode } : {}),
  };

  if (!result.mode && normalizedTools?.length) {
    result.mode = "custom-agent";
  }

  if (!result.threadId) {
    result.threadId = body.thread_id || body.conversation_id || undefined;
  }

  if (process.env.DEBUG_COMMANDCODE === "true") {
    console.log("\n=== COMMANDCODE REQUEST DEBUG ===");
    console.log(JSON.stringify(result, null, 2));
    console.log("================================\n");
  }

  return result;
}

register(FORMATS.OPENAI, FORMATS.COMMANDCODE, openaiToCommandCode, null);
