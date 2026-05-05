import { execSync } from "node:child_process";

import { register } from "../index.js";
import { FORMATS } from "../formats.js";

function normalizeToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto") return undefined;
  if (toolChoice === "none") return { type: "auto" };
  if (toolChoice === "required") return { type: "any" };
  if (typeof toolChoice === "string") {
    return { type: "tool", name: toolChoice };
  }
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
    if (toolType && toolType !== "function") {
      return tool;
    }

    const toolData = toolType === "function" && tool.function ? tool.function : tool;
    return {
      name: toolData?.name || "",
      description: toolData?.description || "",
      input_schema: toolData?.parameters || toolData?.input_schema || { type: "object", properties: {} },
    };
  }).filter((tool) => tool?.name || tool?.type);
}

function tryParseJSON(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function textFromContentParts(parts) {
  if (!Array.isArray(parts)) return typeof parts === "string" ? parts : "";
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function normalizeToolResultContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return textFromContentParts(content);

  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
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

  if (blocks.length === 0) return textFromContentParts(content);
  if (blocks.length === 1 && blocks[0].type === "text") return blocks[0].text;
  return blocks;
}

function getUserBlocks(msg) {
  const blocks = [];

  if (typeof msg.content === "string") {
    if (msg.content) blocks.push({ type: "text", text: msg.content });
    return blocks;
  }

  if (!Array.isArray(msg.content)) return blocks;

  for (const part of msg.content) {
    if (!part || typeof part !== "object") continue;

    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "tool_result") {
      blocks.push({
        type: "tool_result",
        tool_use_id: part.tool_use_id || part.toolCallId || part.id || "",
        content: normalizeToolResultContent(part.content),
        ...(part.is_error ? { is_error: true } : {}),
      });
    } else if (part.type === "image" && part.source) {
      blocks.push({ type: "image", source: part.source });
    } else if (part.type === "image_url" && part.image_url?.url) {
      blocks.push({ type: "image", image: part.image_url.url });
    }
  }

  return blocks;
}

function getAssistantBlocks(msg) {
  const blocks = [];

  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;

      if (part.type === "text" && typeof part.text === "string") {
        blocks.push({ type: "text", text: part.text });
      } else if (part.type === "tool_use") {
        blocks.push({
          type: "tool_use",
          id: part.id || "",
          name: part.name || "",
          input: part.input || {},
        });
      } else if (part.type === "thinking" && typeof part.thinking === "string") {
        blocks.push({ type: "thinking", thinking: part.thinking });
      } else if (part.type === "reasoning" && typeof part.text === "string") {
        blocks.push({ type: "reasoning", text: part.text });
      }
    }
  } else if (typeof msg.content === "string" && msg.content.length > 0) {
    blocks.push({ type: "text", text: msg.content });
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const toolCall of msg.tool_calls) {
      blocks.push({
        type: "tool_use",
        id: toolCall.id || "",
        name: toolCall.function?.name || "",
        input: tryParseJSON(toolCall.function?.arguments || "{}"),
      });
    }
  }

  return blocks;
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

function getPostToolFinalInstruction(originalText) {
  const text = originalText || "";
  const exactMatch = text.match(/respond with exactly\s+(.+?)(?:\.|$)/i)
    || text.match(/reply with exactly\s+(.+?)(?:\.|$)/i);
  if (exactMatch?.[1]) {
    const exact = exactMatch[1].trim().replace(/^['\"]|['\"]$/g, "");
    return `Respond with exactly ${exact} and nothing else.`;
  }
  return "Respond now with the final answer only.";
}

function buildCommandCodeToolFollowup(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return null;

  const last = messages[messages.length - 1];
  if (!last || last.role !== "tool") return null;

  const toolMessageIndex = messages.length - 1;
  const assistantToolCall = [...messages]
    .slice(0, toolMessageIndex)
    .reverse()
    .find((msg) => msg?.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0);
  if (!assistantToolCall) return null;

  const originalUser = messages.find((msg) => msg?.role === "user" && getMessageTextContent(msg.content));
  const originalText = getMessageTextContent(originalUser?.content);
  const toolName = assistantToolCall.tool_calls?.[0]?.function?.name || "tool";
  const toolOutput = getMessageTextContent(last.content);
  if (!toolOutput) return null;

  return [{
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "The required tool call has already completed successfully.",
          `Tool used: ${toolName}.`,
          "Use the tool result internally to finish the task.",
          "Do not repeat or quote the tool output unless the original request explicitly asks for it.",
          originalText && `Original request: ${originalText}`,
          `Tool result is available: ${toolOutput}`,
          "Do not call any tools again.",
          getPostToolFinalInstruction(originalText),
        ].filter(Boolean).join("\n\n"),
      },
    ],
  }];
}

function normalizeCommandCodeMessages(messages) {
  if (!Array.isArray(messages)) return [];

  const toolFollowup = buildCommandCodeToolFollowup(messages);
  if (toolFollowup) return toolFollowup;

  const normalized = [];
  let pendingRole = null;
  let pendingContent = [];

  const flush = () => {
    if (!pendingRole || pendingContent.length === 0) return;
    const content = pendingRole === "user" && pendingContent.every((part) => part?.type === "text")
      ? pendingContent.map((part) => part.text).join("\n")
      : pendingContent;
    normalized.push({ role: pendingRole, content });
    pendingRole = null;
    pendingContent = [];
  };

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;

    if (msg.role === "system") {
      const systemText = textFromContentParts(msg.content);
      if (systemText) {
        if (pendingRole !== "user") flush();
        pendingRole = "user";
        pendingContent.push({ type: "text", text: systemText });
      }
      continue;
    }

    if (msg.role === "tool") {
      flush();
      normalized.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id || "",
            content: normalizeToolResultContent(msg.content),
          },
        ],
      });
      continue;
    }

    if (msg.role === "user") {
      const blocks = getUserBlocks(msg);
      if (blocks.length === 0) continue;
      const hasToolResult = blocks.some((part) => part.type === "tool_result");
      if (hasToolResult) {
        flush();
        normalized.push({ role: "user", content: blocks });
      } else {
        if (pendingRole !== "user") flush();
        pendingRole = "user";
        pendingContent.push(...blocks);
      }
      continue;
    }

    if (msg.role === "assistant") {
      const blocks = getAssistantBlocks(msg);
      if (blocks.length === 0) continue;
      flush();
      normalized.push({ role: "assistant", content: blocks });
      continue;
    }
  }

  flush();

  const lastMessage = normalized[normalized.length - 1];
  const endsWithToolResult = lastMessage?.role === "user"
    && Array.isArray(lastMessage.content)
    && lastMessage.content.some((part) => part?.type === "tool_result");

  if (endsWithToolResult) {
    normalized.push({
      role: "user",
      content: "Now continue and answer the original request using the tool result.",
    });
  }

  return normalized;
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

function getCommandCodeRepoContext() {
  const workingDir = process.cwd();
  const gitRoot = getGitOutput("git rev-parse --show-toplevel");
  const isGitRepo = Boolean(gitRoot);
  const currentBranch = isGitRepo ? getGitOutput("git branch --show-current") : "";
  const mainBranch = isGitRepo
    ? (getGitOutput("git symbolic-ref --short refs/remotes/origin/HEAD").split("/").pop() || "main")
    : "";
  const gitStatus = isGitRepo ? getGitOutput("git status --short") : "";
  const recentCommits = isGitRepo
    ? getGitOutput("git log --oneline -5").split("\n").filter(Boolean)
    : [];

  return {
    workingDir,
    structure: [],
    isGitRepo,
    currentBranch,
    mainBranch,
    gitStatus,
    recentCommits,
  };
}

function buildCommandCodeConfig(body) {
  const repoContext = getCommandCodeRepoContext();

  return {
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    topP: typeof body.top_p === "number" ? body.top_p : undefined,
    presencePenalty: typeof body.presence_penalty === "number" ? body.presence_penalty : undefined,
    frequencyPenalty: typeof body.frequency_penalty === "number" ? body.frequency_penalty : undefined,
    maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
    workingDir: repoContext.workingDir,
    date: new Date().toISOString().split("T")[0],
    environment: process.platform || "linux",
    structure: repoContext.structure,
    isGitRepo: repoContext.isGitRepo,
    currentBranch: repoContext.currentBranch,
    mainBranch: repoContext.mainBranch,
    gitStatus: repoContext.gitStatus,
    recentCommits: repoContext.recentCommits,
  };
}

/**
 * Convert OpenAI request to Command Code format.
 */
function openaiToCommandCode(model, body, stream) {
  const providerSlug = model.split("/")[0] || "moonshotai";
  const messages = normalizeCommandCodeMessages(body.messages);
  const params = {
    messages,
    model,
    provider: providerSlug,
    stream,
  };

  if (typeof body.max_tokens === "number") params.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") params.temperature = body.temperature;
  if (typeof body.top_p === "number") params.top_p = body.top_p;
  if (typeof body.presence_penalty === "number") params.presence_penalty = body.presence_penalty;
  if (typeof body.frequency_penalty === "number") params.frequency_penalty = body.frequency_penalty;
  const normalizedTools = normalizeCommandCodeTools(body.tools);
  if (normalizedTools?.length) params.tools = normalizedTools;

  const normalizedToolChoice = normalizeToolChoice(body.tool_choice);
  if (normalizedToolChoice !== undefined) params.tool_choice = normalizedToolChoice;
  if (body.response_format !== undefined) params.response_format = body.response_format;
  if (typeof body.parallel_tool_calls === "boolean") params.parallel_tool_calls = body.parallel_tool_calls;
  if (body.stop !== undefined) params.stop = body.stop;

  const config = buildCommandCodeConfig(body);

  return {
    model,
    messages,
    memory: typeof body.memory === "string" ? body.memory : "",
    params,
    config,
  };
}

register(FORMATS.OPENAI, FORMATS.COMMANDCODE, openaiToCommandCode, null);
