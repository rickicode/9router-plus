import { MORPH_CAPABILITY_UPSTREAMS } from "@/lib/localDb.js";
import {
  createMorphDispatchError,
  executeWithMorphKeyFailover,
} from "@/lib/morph/keySelection.js";

function buildUpstreamUrl(baseUrl, upstreamPath) {
  return new URL(upstreamPath, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

export async function dispatchMorphCapability({ capability, req, morphSettings }) {
  const upstreamTarget = MORPH_CAPABILITY_UPSTREAMS[capability];

  if (!upstreamTarget) {
    throw new Error(`Unsupported Morph capability: ${capability}`);
  }

  const body = await req.text().catch((cause) => {
    throw createMorphDispatchError("Failed to read Morph request body", {
      cause,
      dispatchStarted: false,
    });
  });

  const response = await executeWithMorphKeyFailover({
    apiKeys: morphSettings?.apiKeys,
    roundRobinEnabled: morphSettings?.roundRobinEnabled,
    rotationKey: capability,
    execute: async ({ apiKey }) => {
      const upstreamResponse = await fetch(
        buildUpstreamUrl(morphSettings.baseUrl, upstreamTarget.path),
        {
          method: upstreamTarget.method,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body,
        }
      ).catch((cause) => {
        throw createMorphDispatchError("Morph upstream request failed", {
          cause,
          dispatchStarted: true,
        });
      });

      return upstreamResponse;
    },
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
