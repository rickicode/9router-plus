import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import {
	appendRequestLog,
	saveRequestDetail,
} from "../../runtime/usagePersistence.js";
import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { FORMATS } from "../../translator/formats.js";
import { initState, translateResponse } from "../../translator/index.js";
import { createErrorResult } from "../../utils/error.js";
import {
	buildRequestDetail,
	extractRequestConfig,
	saveUsageStats,
} from "./requestDetail.js";

function openAICompletionToClaudeMessage(parsed, fallbackModel) {
	const choice = parsed?.choices?.[0] || {};
	const message = choice.message || {};
	const content = [];

	if (message.reasoning_content) {
		content.push({ type: "thinking", thinking: message.reasoning_content });
	}
	if (typeof message.content === "string" && message.content.length > 0) {
		content.push({ type: "text", text: message.content });
	}
	if (Array.isArray(message.tool_calls)) {
		for (const toolCall of message.tool_calls) {
			let input = {};
			try {
				input = JSON.parse(toolCall?.function?.arguments || "{}");
			} catch {
				input = {};
			}
			content.push({
				type: "tool_use",
				id: toolCall.id,
				name: toolCall.function?.name || "",
				input,
			});
		}
	}

	return {
		id: String(parsed?.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
		type: "message",
		role: "assistant",
		model: parsed?.model || fallbackModel || "claude",
		content,
		stop_reason:
			choice.finish_reason === "tool_calls"
				? "tool_use"
				: choice.finish_reason === "length"
					? "max_tokens"
					: "end_turn",
		stop_sequence: null,
		usage: {
			input_tokens: parsed?.usage?.prompt_tokens || 0,
			output_tokens: parsed?.usage?.completion_tokens || 0,
		},
	};
}

function textFromResponsesMessageItem(item) {
	if (!item?.content || !Array.isArray(item.content)) return "";
	const byType = item.content.find((c) => c.type === "output_text");
	if (typeof byType?.text === "string") return byType.text;
	const anyText = item.content.find((c) => typeof c.text === "string");
	if (typeof anyText?.text === "string") return anyText.text;
	return "";
}

/**
 * Codex / Responses API may emit many alternating reasoning + message items.
 * Early message blocks often have empty output_text; the user-visible answer is usually in the last non-empty message.
 */
function pickAssistantMessageForChatCompletion(output) {
	if (!Array.isArray(output)) return { msgItem: null, textContent: null };
	const messages = output.filter((item) => item?.type === "message");
	if (messages.length === 0) return { msgItem: null, textContent: null };
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = textFromResponsesMessageItem(messages[i]);
		if (text.length > 0) return { msgItem: messages[i], textContent: text };
	}
	const last = messages[messages.length - 1];
	return { msgItem: last, textContent: textFromResponsesMessageItem(last) };
}

/**
 * Parse OpenAI-style SSE text into a single chat completion JSON.
 * Used when provider forces streaming but client wants non-streaming.
 */
export function parseSSEToOpenAIResponse(rawSSE, fallbackModel) {
	const chunks = [];

	for (const line of String(rawSSE || "").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const payload = trimmed.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		try {
			chunks.push(JSON.parse(payload));
		} catch {
			/* ignore malformed lines */
		}
	}

	if (chunks.length === 0) return null;

	const first = chunks[0];
	const contentParts = [];
	const reasoningParts = [];
	const toolCallMap = new Map(); // index -> { id, type, function: { name, arguments } }
	let finishReason = "stop";
	let usage = null;

	for (const chunk of chunks) {
		const choice = chunk?.choices?.[0];
		const delta = choice?.delta || {};
		if (typeof delta.content === "string" && delta.content.length > 0)
			contentParts.push(delta.content);
		if (
			typeof delta.reasoning_content === "string" &&
			delta.reasoning_content.length > 0
		)
			reasoningParts.push(delta.reasoning_content);
		if (choice?.finish_reason) finishReason = choice.finish_reason;
		if (chunk?.usage && typeof chunk.usage === "object") usage = chunk.usage;

		// Accumulate tool_calls from streaming deltas
		if (Array.isArray(delta.tool_calls)) {
			for (const tc of delta.tool_calls) {
				const idx = tc.index ?? 0;
				if (!toolCallMap.has(idx)) {
					toolCallMap.set(idx, {
						id: tc.id || "",
						type: "function",
						function: { name: "", arguments: "" },
					});
				}
				const existing = toolCallMap.get(idx);
				if (tc.id) existing.id = tc.id;
				if (tc.function?.name) existing.function.name += tc.function.name;
				if (tc.function?.arguments)
					existing.function.arguments += tc.function.arguments;
			}
		}
	}

	const message = {
		role: "assistant",
		content: contentParts.join("") || (toolCallMap.size > 0 ? null : ""),
	};
	if (reasoningParts.length > 0)
		message.reasoning_content = reasoningParts.join("");
	if (toolCallMap.size > 0) {
		message.tool_calls = [...toolCallMap.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([, tc]) => tc);
	}

	const result = {
		id: first.id || `chatcmpl-${Date.now()}`,
		object: "chat.completion",
		created: first.created || Math.floor(Date.now() / 1000),
		model: first.model || fallbackModel || "unknown",
		choices: [{ index: 0, message, finish_reason: finishReason }],
	};
	if (usage) result.usage = usage;
	return result;
}

/**
 * Parse Command Code SSE format into a single chat completion JSON.
 * Command Code SSE uses custom event types: start, text-start, text-delta, text-end, finish.
 */
export async function parseCommandCodeSSEToOpenAIResponse(rawSSE, fallbackModel) {
	const state = { ...initState(FORMATS.OPENAI), model: fallbackModel || "unknown" };
	const chunks = [];
	const rawLines = Array.isArray(rawSSE) ? rawSSE : String(rawSSE || "").split("\n");

	for (const line of rawLines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed = null;
		if (trimmed.startsWith("data:")) {
			const payload = trimmed.slice(5).trim();
			if (!payload || payload === "[DONE]") continue;
			try {
				parsed = JSON.parse(payload);
			} catch {
				parsed = null;
			}
		} else if (trimmed.startsWith("{")) {
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				parsed = null;
			}
		}
		if (!parsed) continue;
		chunks.push(parsed);
	}

	if (chunks.length === 0) return null;

	const openaiChunks = [];
	for (const chunk of chunks) {
		const translated = await translateResponse(FORMATS.COMMANDCODE, FORMATS.OPENAI, chunk, state);
		if (translated?.length) openaiChunks.push(...translated);
	}

	if (openaiChunks.length === 0) return null;

	const first = openaiChunks[0];
	const contentParts = [];
	const reasoningParts = [];
	const toolCallMap = new Map();
	let finishReason = "stop";
	let usage = null;

	for (const chunk of openaiChunks) {
		const choice = chunk?.choices?.[0];
		const delta = choice?.delta || {};
		if (typeof delta.content === "string" && delta.content.length > 0) contentParts.push(delta.content);
		if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) reasoningParts.push(delta.reasoning_content);
		if (choice?.finish_reason) finishReason = choice.finish_reason;
		if (chunk?.usage && typeof chunk.usage === "object") usage = chunk.usage;
		if (Array.isArray(delta.tool_calls)) {
			for (const tc of delta.tool_calls) {
				const idx = tc.index ?? 0;
				if (!toolCallMap.has(idx)) {
					toolCallMap.set(idx, {
						id: tc.id || "",
						type: "function",
						function: { name: "", arguments: "" },
					});
				}
				const existing = toolCallMap.get(idx);
				if (tc.id) existing.id = tc.id;
				if (tc.function?.name) {
					const nextName = tc.function.name;
					existing.function.name = nextName.startsWith(existing.function.name)
						? nextName
						: `${existing.function.name}${nextName}`;
				}
				if (tc.function?.arguments) {
					const nextArgs = tc.function.arguments;
					existing.function.arguments = nextArgs.startsWith(existing.function.arguments)
						? nextArgs
						: `${existing.function.arguments}${nextArgs}`;
				}
			}
		}
	}

	const combinedContent = contentParts.join("");
	const trimmedContent = combinedContent.trim();
	const pseudoToolMarkupOnly = toolCallMap.size > 0
		&& trimmedContent.length > 0
		&& /^<tool_calls?>[\s\S]*<\/tool_calls?>$/i.test(trimmedContent);
	const message = {
		role: "assistant",
		content: pseudoToolMarkupOnly ? null : (combinedContent || (toolCallMap.size > 0 ? null : "")),
	};
	if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");
	if (toolCallMap.size > 0) {
		message.tool_calls = [...toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
	}

	const result = {
		id: first.id || `chatcmpl-${Date.now()}`,
		object: "chat.completion",
		created: first.created || Math.floor(Date.now() / 1000),
		model: first.model || fallbackModel || "unknown",
		choices: [{ index: 0, message, finish_reason: finishReason }],
	};
	if (usage) result.usage = usage;
	return result;
}

/**
 * Handle case: provider forced streaming but client wants JSON.
 * Supports Responses API SSE and standard Chat Completions SSE.
 */
export async function handleForcedSSEToJson({
	providerResponse,
	sourceFormat,
	provider,
	model,
	body,
	stream,
	translatedBody,
	finalBody,
	requestStartTime,
	connectionId,
	apiKey,
	clientRawRequest,
	onRequestSuccess,
	trackDone,
	appendLog,
}) {
	const contentType = providerResponse.headers.get("content-type") || "";
	const isSSE = contentType.includes("text/event-stream");
	if (!isSSE) return null; // not handled here

	trackDone();

	const ctx = {
		provider,
		model,
		connectionId,
		request: extractRequestConfig(body, stream),
		providerRequest: finalBody || translatedBody || null,
	};

	// Responses API SSE path
	const isResponsesApi = sourceFormat === FORMATS.OPENAI_RESPONSES;
	if (isResponsesApi) {
		try {
			const jsonResponse = await convertResponsesStreamToJson(
				providerResponse.body,
			);
			if (onRequestSuccess) await onRequestSuccess();

			const usage = jsonResponse.usage || {};
			appendLog({ tokens: usage, status: "200 OK" });
			saveUsageStats({
				provider,
				model,
				tokens: usage,
				connectionId,
				apiKey,
				endpoint: clientRawRequest?.endpoint,
			});

			const { msgItem, textContent } = pickAssistantMessageForChatCompletion(
				jsonResponse.output,
			);
			const totalLatency = Date.now() - requestStartTime;

			saveRequestDetail(
				buildRequestDetail(
					{
						...ctx,
						latency: { ttft: totalLatency, total: totalLatency },
						tokens: {
							prompt_tokens: usage.input_tokens || 0,
							completion_tokens: usage.output_tokens || 0,
						},
						response: {
							content: textContent,
							thinking: null,
							finish_reason: jsonResponse.status || "unknown",
						},
						status: "success",
					},
					{ endpoint: clientRawRequest?.endpoint || null },
				),
			).catch(() => {});

			// Client is Responses API → return as-is
			if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
				return {
					success: true,
					response: new Response(JSON.stringify(jsonResponse), {
						headers: {
							"Content-Type": "application/json",
							"Access-Control-Allow-Origin": "*",
						},
					}),
				};
			}

			// Build client-format response
			const inTokens = usage.input_tokens || 0;
			const outTokens = usage.output_tokens || 0;
			let finalResp;

			// Extract tool calls from Responses API output (function_call items)
			const funcCallItems = (jsonResponse.output || []).filter(
				(item) => item.type === "function_call",
			);
			const toolCalls = funcCallItems.map((item, idx) => ({
				id: item.call_id || `call_${item.name}_${Date.now()}_${idx}`,
				type: "function",
				function: {
					name: item.name,
					arguments:
						typeof item.arguments === "string"
							? item.arguments
							: JSON.stringify(item.arguments || {}),
				},
			}));
			const hasToolCalls = toolCalls.length > 0;

			if (
				sourceFormat === FORMATS.ANTIGRAVITY ||
				sourceFormat === FORMATS.GEMINI ||
				sourceFormat === FORMATS.GEMINI_CLI
			) {
				finalResp = {
					response: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [{ text: textContent || "" }],
								},
								finishReason: "STOP",
								index: 0,
							},
						],
						usageMetadata: {
							promptTokenCount: inTokens,
							candidatesTokenCount: outTokens,
							totalTokenCount: inTokens + outTokens,
						},
						modelVersion: model,
						responseId: jsonResponse.id || `resp_${Date.now()}`,
					},
				};
			} else {
				const message = {
					role: "assistant",
					content: textContent || (hasToolCalls ? null : ""),
				};
				if (hasToolCalls) message.tool_calls = toolCalls;
				const finishReason = hasToolCalls
					? "tool_calls"
					: jsonResponse.status === "completed"
						? "stop"
						: jsonResponse.status || "stop";
				finalResp = {
					id: jsonResponse.id || `chatcmpl-${Date.now()}`,
					object: "chat.completion",
					created: jsonResponse.created_at || Math.floor(Date.now() / 1000),
					model: jsonResponse.model || model,
					choices: [{ index: 0, message, finish_reason: finishReason }],
					usage: {
						prompt_tokens: inTokens,
						completion_tokens: outTokens,
						total_tokens: inTokens + outTokens,
					},
				};
			}

			return {
				success: true,
				response: new Response(JSON.stringify(finalResp), {
					headers: {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": "*",
					},
				}),
			};
		} catch (err) {
			console.error("[ChatCore] Responses API SSE→JSON failed:", err);
			if (err?.name === "AbortError") {
				const status =
					err.code === "UPSTREAM_TIMEOUT" || err.code === "STREAM_IDLE_TIMEOUT"
						? HTTP_STATUS.GATEWAY_TIMEOUT
						: 499;
				return createErrorResult(
					status,
					err.message ||
						(status === HTTP_STATUS.GATEWAY_TIMEOUT
							? "Upstream request timed out"
							: "Request aborted"),
				);
			}
			return createErrorResult(
				HTTP_STATUS.BAD_GATEWAY,
				"Failed to convert streaming response to JSON",
			);
		}
	}

	// Standard Chat Completions SSE path
	try {
		const sseText = await providerResponse.text();

		let parsed;
		if (sourceFormat === FORMATS.COMMANDCODE || provider === "commandcode") {
			parsed = await parseCommandCodeSSEToOpenAIResponse(sseText, model);
		} else {
			parsed = parseSSEToOpenAIResponse(sseText, model);
		}
		if (!parsed)
			return createErrorResult(
				HTTP_STATUS.BAD_GATEWAY,
				"Invalid SSE response for non-streaming request",
			);

		if (onRequestSuccess) await onRequestSuccess();

		const usage = parsed.usage || {};
		appendLog({ tokens: usage, status: "200 OK" });
		saveUsageStats({
			provider,
			model,
			tokens: usage,
			connectionId,
			apiKey,
			endpoint: clientRawRequest?.endpoint,
		});

		const totalLatency = Date.now() - requestStartTime;
		saveRequestDetail(
			buildRequestDetail(
				{
					...ctx,
					latency: { ttft: totalLatency, total: totalLatency },
					tokens: usage,
					response: {
						content: parsed.choices?.[0]?.message?.content || null,
						thinking: parsed.choices?.[0]?.message?.reasoning_content || null,
						finish_reason: parsed.choices?.[0]?.finish_reason || "unknown",
					},
					status: "success",
				},
				{ endpoint: clientRawRequest?.endpoint || null },
			),
		).catch(() => {});

		// Strip reasoning_content only when content is non-empty.
		// When content is empty (e.g. thinking models that used all tokens for reasoning),
		// reasoning_content is the only useful output and must be preserved.
		// Previously this was unconditional, which broke Qwen3.5, Claude extended thinking, etc.
		if (parsed?.choices) {
			for (const choice of parsed.choices) {
				if (choice?.message?.reasoning_content && choice.message.content) {
					delete choice.message.reasoning_content;
				}
			}
		}

		const finalResponse = sourceFormat === FORMATS.CLAUDE
			? openAICompletionToClaudeMessage(parsed, model)
			: parsed;

		return {
			success: true,
			response: new Response(JSON.stringify(finalResponse), {
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
				},
			}),
		};
	} catch (err) {
		console.error("[ChatCore] Chat Completions SSE→JSON failed:", err);
		if (err?.name === "AbortError") {
			const status =
				err.code === "UPSTREAM_TIMEOUT" || err.code === "STREAM_IDLE_TIMEOUT"
					? HTTP_STATUS.GATEWAY_TIMEOUT
					: 499;
			return createErrorResult(
				status,
				err.message ||
					(status === HTTP_STATUS.GATEWAY_TIMEOUT
						? "Upstream request timed out"
						: "Request aborted"),
			);
		}
		return createErrorResult(
			HTTP_STATUS.BAD_GATEWAY,
			"Failed to convert streaming response to JSON",
		);
	}
}
