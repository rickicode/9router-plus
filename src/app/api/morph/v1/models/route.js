import { getConfiguredMorphSettings, logMorphApiAccess } from "@/app/api/morph/_shared.js";

const DEFAULT_MORPH_MODELS = [
  { id: "morph-v3-large", owned_by: "morph" },
  { id: "morph-v3-fast", owned_by: "morph" },
  { id: "morph-embedding-v4", owned_by: "morph" },
];

function buildMorphModelsResponse() {
  const created = Math.floor(Date.now() / 1000);

  return {
    object: "list",
    data: DEFAULT_MORPH_MODELS.map((model) => ({
      id: model.id,
      object: "model",
      created,
      owned_by: model.owned_by,
      permission: [],
      root: model.id,
      parent: null,
    })),
  };
}

export async function OPTIONS(request) {
  logMorphApiAccess(request);
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function GET(request) {
  logMorphApiAccess(request);
  const morphSettings = await getConfiguredMorphSettings();

  if (!morphSettings) {
    return Response.json({ error: "Morph is not configured" }, { status: 503 });
  }

  return Response.json(buildMorphModelsResponse(), {
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export { buildMorphModelsResponse, DEFAULT_MORPH_MODELS };
