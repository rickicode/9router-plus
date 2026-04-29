import { createMorphCapabilityPostHandler } from "@/app/morphllm/_routeFactory.js";

const RAW_MORPH_RERANK = { method: "POST", path: "/v1/rerank" };

export const POST = createMorphCapabilityPostHandler({
  capability: "rerank",
  upstreamTarget: RAW_MORPH_RERANK,
  requestLabel: "morph:/v1/rerank",
});
