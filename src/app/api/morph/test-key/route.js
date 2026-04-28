import { NextResponse } from "next/server";
import { atomicUpdateSettings, getSettings } from "@/lib/localDb.js";

function buildUpstreamUrl(baseUrl) {
  return new URL("/v1/chat/completions", `${String(baseUrl).replace(/\/+$/, "")}/`).toString();
}

export const dynamic = "force-dynamic";

export function isMorphExhaustedResponse(status, responseText) {
  if (![402, 403, 429].includes(Number(status))) {
    return false;
  }

  const text = String(responseText || "").toLowerCase();
  return text.includes("credit")
    || text.includes("quota")
    || text.includes("exhaust")
    || text.includes("insufficient")
    || text.includes("payment required");
}

export function isMorphInvalidKeyResponse(status, responseText) {
  if (![400, 401, 403].includes(Number(status))) {
    return false;
  }

  const text = String(responseText || "").toLowerCase();
  return text.includes("invalid api key")
    || text.includes("invalid_api_key")
    || text.includes("api key is invalid")
    || text.includes("invalid key")
    || text.includes("unauthorized")
    || text.includes("authentication")
    || text.includes("invalid bearer")
    || text.includes("bad credentials")
    || text.includes("forbidden");
}

export function buildMorphKeyStatusPatch({ status, responseText, fallbackLabel } = {}) {
  const now = new Date().toISOString();

  if (status >= 200 && status < 300) {
    return {
      status: "active",
      isExhausted: false,
      lastCheckedAt: now,
      lastError: "",
    };
  }

  if (isMorphExhaustedResponse(status, responseText)) {
    return {
      status: "exhausted",
      isExhausted: true,
      lastCheckedAt: now,
      lastError: responseText || fallbackLabel || `HTTP ${status}`,
    };
  }

  if (isMorphInvalidKeyResponse(status, responseText)) {
    return {
      status: "inactive",
      isExhausted: false,
      lastCheckedAt: now,
      lastError: responseText || fallbackLabel || `HTTP ${status}`,
    };
  }

  return {
    status: "active",
    isExhausted: false,
    lastCheckedAt: now,
    lastError: "",
  };
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const settings = await getSettings();
    const morph = settings?.morph || {};
    const apiKeys = Array.isArray(morph.apiKeys) ? morph.apiKeys : [];
    const target = apiKeys.find((entry) => entry?.email === email);

    if (!target?.key) {
      return NextResponse.json({ error: "Morph API key not found" }, { status: 404 });
    }

    const response = await fetch(buildUpstreamUrl(morph.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "morph-v3-fast",
        messages: [
          {
            role: "user",
            content: "<instruction>Reply with exactly OK</instruction>",
          },
        ],
      }),
    });

    const responseText = await response.text().catch(() => "");
    const nextPatch = buildMorphKeyStatusPatch({
      status: response.status,
      responseText,
      fallbackLabel: `HTTP ${response.status}`,
    });
    const isActive = nextPatch.status === "active";

    await atomicUpdateSettings((current) => ({
      ...current,
      morph: {
        ...(current?.morph || {}),
        apiKeys: (Array.isArray(current?.morph?.apiKeys) ? current.morph.apiKeys : []).map((entry) => (
          entry?.email === email
            ? { ...entry, ...nextPatch }
            : entry
        )),
      },
    }));

    return NextResponse.json({
      ok: isActive,
      email,
      status: nextPatch.status,
      isExhausted: nextPatch.isExhausted,
      lastError: nextPatch.lastError,
    }, { status: isActive ? 200 : 409 });
  } catch (error) {
    console.error("[API] Failed to test Morph API key:", error);
    return NextResponse.json({ error: "Failed to test Morph API key" }, { status: 500 });
  }
}
