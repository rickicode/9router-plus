import { createMorphCapabilityPostHandler } from "@/app/morphllm/_routeFactory.js";

const RAW_MORPH_CHAT_COMPLETIONS = { method: "POST", path: "/v1/chat/completions" };

export const POST = createMorphCapabilityPostHandler({
  capability: "apply",
  upstreamTarget: RAW_MORPH_CHAT_COMPLETIONS,
  requestLabel: "morph:/v1/chat/completions",
});
