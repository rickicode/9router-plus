import { createMorphCapabilityPostHandler } from "@/app/morphllm/_routeFactory.js";

const RAW_MORPH_COMPACT = { method: "POST", path: "/v1/compact" };

export const POST = createMorphCapabilityPostHandler({
  capability: "compact",
  upstreamTarget: RAW_MORPH_COMPACT,
  requestLabel: "morph:/v1/compact",
});
