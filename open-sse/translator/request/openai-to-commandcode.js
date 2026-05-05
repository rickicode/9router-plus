import { register } from "../index.js";
import { FORMATS } from "../formats.js";

function normalizeToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto") return undefined;
  if (toolChoice === "none") return "none";
  if (toolChoice === "required") return "required";
  if (typeof toolChoice === "string") return toolChoice;
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

function buildCommandCodeConfig(body) {
  return {
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    topP: typeof body.top_p === "number" ? body.top_p : undefined,
    presencePenalty: typeof body.presence_penalty === "number" ? body.presence_penalty : undefined,
    frequencyPenalty: typeof body.frequency_penalty === "number" ? body.frequency_penalty : undefined,
    maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
    workingDir: "/tmp",
    date: new Date().toISOString().split("T")[0],
    environment: process.platform || "linux",
    structure: [],
    isGitRepo: false,
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [],
  };
}

/**
 * Convert OpenAI request to Command Code format.
 */
function openaiToCommandCode(model, body, stream) {
  const providerSlug = model.split("/")[0] || "moonshotai";
  const messages = Array.isArray(body.messages) ? body.messages : [];
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
