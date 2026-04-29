import { createMorphCapabilityPostHandler } from "@/app/morphllm/_routeFactory.js";

const RAW_MORPH_EMBEDDINGS = { method: "POST", path: "/v1/embeddings" };

export const POST = createMorphCapabilityPostHandler({
  capability: "embeddings",
  upstreamTarget: RAW_MORPH_EMBEDDINGS,
  requestLabel: "morph:/v1/embeddings",
});
