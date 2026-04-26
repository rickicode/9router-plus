/**
 * Normalize Responses API input to array format.
 * Accepts string or array, returns array of message items.
 * An empty array is treated like an empty string — providers require at least one user
 * message, so we inject a placeholder rather than forwarding an empty messages[].
 * @param {string|Array} input - raw input from Responses API body
 * @returns {Array|null} normalized array or null if invalid
 */
export function normalizeResponsesInput(input) {
  if (typeof input === "string") {
    const text = input.trim() === "" ? "..." : input;
    return [{ type: "message", role: "user", content: [{ type: "input_text", text }] }];
  }
  if (Array.isArray(input)) {
    // Empty input[] would produce messages:[] which all providers reject (#389)
    if (input.length === 0) {
      return [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
    }
    return input;
  }
  return null;
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

function normalizeImageUrlLike(value) {
  if (typeof value === "string") return { url: value, detail: undefined };
  if (value && typeof value === "object") {
    return {
      url: pickFirstString(value.url, value.href, value.file_data, value.file?.file_data),
      detail: pickFirstString(value.detail, value.quality),
    };
  }
  return { url: "", detail: undefined };
}

function normalizeFileLike(part) {
  const nestedFile = part.file && typeof part.file === "object" ? part.file : {};
  const nestedImage = part.image_url && typeof part.image_url === "object" ? part.image_url : {};
  const nestedMime = nestedFile.mime_type || nestedFile.mimeType || nestedImage.mime_type || nestedImage.mimeType || "";

  return {
    fileData: pickFirstString(
      part.file_data,
      nestedFile.file_data,
      nestedFile.data,
      part.data,
      nestedImage.file_data,
      nestedImage.data,
    ),
    mimeType: pickFirstString(part.mime_type, part.mimeType, nestedMime),
    filename: pickFirstString(part.filename, nestedFile.filename, nestedFile.name, part.name),
  };
}

function normalizeResponsesContentPart(part) {
  if (!part || typeof part !== "object") return part;

  if (part.type === "input_text") {
    return { type: "text", text: part.text || "" };
  }

  if (part.type === "output_text") {
    return { type: "text", text: part.text || "" };
  }

  if (part.type === "input_image") {
    const image = normalizeImageUrlLike(part.image_url);
    const file = normalizeFileLike(part);
    const url = pickFirstString(image.url, file.fileData, part.file_id);

    return {
      type: "image_url",
      image_url: {
        url,
        detail: pickFirstString(part.detail, image.detail, part.image_url?.detail) || "auto"
      }
    };
  }

  if (part.type === "input_file") {
    const { fileData, mimeType, filename } = normalizeFileLike(part);

    if (typeof fileData === "string" && fileData.startsWith("data:")) {
      return {
        type: "image_url",
        image_url: {
          url: fileData,
          detail: part.detail || "auto"
        }
      };
    }

    if (fileData && mimeType.startsWith("image/")) {
      return {
        type: "image_url",
        image_url: {
          url: `data:${mimeType};base64,${fileData}`,
          detail: part.detail || "auto"
        }
      };
    }

    return {
      type: "file",
      file: {
        file_data: fileData,
        filename,
        mime_type: mimeType,
      }
    };
  }

  return part;
}

/**
 * Convert OpenAI Responses API format to standard chat completions format
 * Responses API uses: { input: [...], instructions: "..." }
 * Chat API uses: { messages: [...] }
 */
export function convertResponsesApiFormat(body) {
  if (!body.input) return body;

  const result = { ...body };
  result.messages = [];

  // Convert instructions to system message
  if (body.instructions) {
    result.messages.push({ role: "system", content: body.instructions });
  }

  // Group items by conversation turn
  let currentAssistantMsg = null;
  let pendingToolCalls = [];
  let pendingToolResults = [];

  const inputItems = normalizeResponsesInput(body.input);
  if (!inputItems) return body;

  for (const item of inputItems) {
    // Determine item type - Droid CLI sends role-based items without 'type' field
    // Fallback: if no type but has role property, treat as message
    const itemType = item.type || (item.role ? "message" : null);

    if (itemType === "message") {
      // Flush any pending assistant message with tool calls
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Flush pending tool results
      if (pendingToolResults.length > 0) {
        for (const tr of pendingToolResults) {
          result.messages.push(tr);
        }
        pendingToolResults = [];
      }

      // Convert content: input_text → text, output_text → text, input_image → image_url
      const content = Array.isArray(item.content)
        ? item.content.map(normalizeResponsesContentPart)
        : item.content;
      result.messages.push({ role: item.role, content });
    }
    else if (itemType === "function_call") {
      // Start or append to assistant message with tool_calls
      if (!currentAssistantMsg) {
        currentAssistantMsg = {
          role: "assistant",
          content: null,
          tool_calls: []
        };
      }
      // Skip items with empty/missing name — upstream APIs reject nameless tool calls (#444)
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") continue;
      currentAssistantMsg.tool_calls.push({
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments
        }
      });
    }
    else if (itemType === "function_call_output") {
      // Flush assistant message first if exists
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Add tool result
      pendingToolResults.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output)
      });
    }
    else if (itemType === "reasoning") {
      // Skip reasoning items - they are for display only
      continue;
    }
  }

  // Flush remaining
  if (currentAssistantMsg) {
    result.messages.push(currentAssistantMsg);
  }
  if (pendingToolResults.length > 0) {
    for (const tr of pendingToolResults) {
      result.messages.push(tr);
    }
  }

  // Cleanup Responses API specific fields
  delete result.input;
  delete result.instructions;
  delete result.include;
  delete result.prompt_cache_key;
  delete result.store;
  delete result.reasoning;

  return result;
}
