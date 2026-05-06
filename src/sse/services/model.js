// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes } from "@/lib/localDb";
import { parseModel, resolveModelAliasFromMap, getModelInfoCore } from "open-sse/services/model.js";
import { AI_PROVIDERS, APIKEY_PROVIDERS, resolveProviderId } from "@/shared/constants/providers.js";

export { parseModel };

// Providers that are known to the system (real provider IDs, not model prefixes)
const KNOWN_PROVIDER_IDS = new Set([
  ...Object.keys(AI_PROVIDERS || {}),
  ...Object.keys(APIKEY_PROVIDERS || {}),
  "openai", "anthropic", "gemini", "openrouter", "commandcode",
  "glm", "glm-cn", "kimi", "minimax", "minimax-cn",
  "volcengine-ark", "alicode", "alicode-intl",
]);

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    if (parsed.provider === parsed.providerAlias) {
      // Check OpenAI Compatible nodes
      const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
      const matchedOpenAI = openaiNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedOpenAI) {
        return { provider: matchedOpenAI.id, model: parsed.model };
      }

      // Check Anthropic Compatible nodes
      const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
      const matchedAnthropic = anthropicNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedAnthropic) {
        return { provider: matchedAnthropic.id, model: parsed.model };
      }

      // Provider not recognized — likely a Command Code model prefix (e.g. moonshotai, deepseek, glm, qwen)
      // Keep model as-is (e.g. "moonshotai/Kimi-K2.6") — Command Code API expects full provider/model string
      if (!KNOWN_PROVIDER_IDS.has(parsed.provider)) {
        const commandcodeId = resolveProviderId("commandcode") || "commandcode";
        return { provider: commandcodeId, model: modelStr, isCommandCode: true };
      }
    }
    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  const combo = await getComboByName(parsed.model);
  if (combo) {
    return { provider: null, model: parsed.model };
  }

  return getModelInfoCore(modelStr, getModelAliases);
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr) {
  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  const combo = await getComboByName(modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}
