import { NextResponse } from "next/server";
import { atomicUpdateSettings, getSettings } from "@/lib/localDb";
import { v4 as uuidv4 } from "uuid";
import {
  generateCloudSecret,
  registerWithWorker,
  probeCloudHealth,
} from "@/lib/cloudWorkerClient";

const VALID_STATUSES = new Set([
  "unknown",
  "online",
  "offline",
  "error",
  "unauthorized",
  "not_registered",
]);

function sanitizeForResponse(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const { secret, ...rest } = entry;
  return { ...rest, hasSecret: typeof secret === "string" && secret.length > 0 };
}

function sanitizeListForResponse(entries) {
  return Array.isArray(entries) ? entries.map(sanitizeForResponse) : [];
}

function normalizeUrl(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\/$/, "");
}

function validateUrl(urlString) {
  try {
    const url = new URL(urlString);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("URL must be a valid HTTP or HTTPS address");
    }

    const isProduction = process.env.NODE_ENV === "production";
    const isDevelopment = process.env.NODE_ENV === "development";
    const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";

    if (isProduction && url.protocol === "http:" && !isLocalhost) {
      throw new Error("HTTPS required for production URLs");
    }

    const hostname = url.hostname;
    const privateIpPatterns = [
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^192\.168\./,
      /^169\.254\./,
      /^::1$/,
      /^fe80:/i,
      /^fc00:/i,
    ];

    if (isProduction && privateIpPatterns.some((pattern) => pattern.test(hostname)) && !isLocalhost) {
      throw new Error("Private IP addresses not allowed");
    }

    return url.toString();
  } catch (error) {
    throw new Error(error.message || "Invalid URL format");
  }
}

function hasValidOrigin(request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");

  if (!host) {
    return false;
  }

  if (process.env.NODE_ENV === "production" && !origin) {
    return false;
  }

  if (!origin) return true;

  try {
    const originHost = new URL(origin).host;
    return originHost === host;
  } catch {
    return false;
  }
}

async function readCloudUrls() {
  const settings = await getSettings();
  return Array.isArray(settings.cloudUrls) ? settings.cloudUrls : [];
}

function buildWorkerRegistrationMetadata(settings = {}) {
  const runtimeUrl = normalizeUrl(settings.r2RuntimePublicBaseUrl);
  const cacheTtlSeconds = Number.isInteger(settings.r2RuntimeCacheTtlSeconds)
    ? settings.r2RuntimeCacheTtlSeconds
    : undefined;

  return {
    ...(runtimeUrl ? { runtimeUrl } : {}),
    ...(cacheTtlSeconds ? { cacheTtlSeconds } : {}),
  };
}

async function writeCloudUrls(mutator) {
  const settings = await atomicUpdateSettings(async (currentSettings) => {
    const currentUrls = Array.isArray(currentSettings.cloudUrls) ? currentSettings.cloudUrls : [];
    const clonedUrls = currentUrls.map((entry) => structuredClone(entry));
    const nextUrls = await mutator(clonedUrls);

    return {
      ...currentSettings,
      cloudUrls: nextUrls,
    };
  });

  return settings.cloudUrls;
}

function getNextId(cloudUrls) {
  return uuidv4();
}

export async function GET() {
  try {
    return NextResponse.json({ cloudUrls: sanitizeListForResponse(await readCloudUrls()) });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to load cloud URLs" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    if (!hasValidOrigin(request)) {
      return NextResponse.json({ error: "CSRF validation failed" }, { status: 403 });
    }

    const body = await request.json();
    const rawUrl = normalizeUrl(body?.url);
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";

    if (!rawUrl) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    const url = validateUrl(rawUrl);

    // Probe liveness first so we fail fast if the URL is wrong.
    const probe = await probeCloudHealth(url);
    if (!probe.ok) {
      return NextResponse.json(
        { error: `Worker is not reachable: ${probe.error || "unknown error"}` },
        { status: 502 }
      );
    }

    // Generate a fresh per-worker secret and register with the worker before
    // persisting the entry locally. If register fails we never store the URL
    // — this keeps the local state and the worker state consistent.
    const secret = generateCloudSecret();
    let registerResult;
    try {
      const settings = await getSettings();
      registerResult = await registerWithWorker(url, secret, null, buildWorkerRegistrationMetadata(settings));
    } catch (error) {
      return NextResponse.json(
        { error: `Worker registration failed: ${error.message || "unknown error"}` },
        { status: 502 }
      );
    }

    let createdEntry = null;
    const updated = await writeCloudUrls((cloudUrls) => {
      if (cloudUrls.some((entry) => normalizeUrl(entry.url) === url)) {
        throw new Error("Cloud URL already exists");
      }

      const nextEntry = {
        id: getNextId(cloudUrls),
        name: name || new URL(url).hostname,
        url,
        secret,
        status: "online",
        version: registerResult?.version || probe.version || null,
        latencyMs: probe.latencyMs ?? null,
        lastChecked: new Date().toISOString(),
        registeredAt: registerResult?.registeredAt || new Date().toISOString(),
        lastSyncAt: null,
        lastSyncOk: null,
        lastSyncError: null,
        providersCount: null,
      };

      createdEntry = nextEntry;
      return [...cloudUrls, nextEntry];
    });

    return NextResponse.json(
      {
        cloudUrls: sanitizeListForResponse(updated),
        created: sanitizeForResponse(createdEntry),
      },
      { status: 201 }
    );
  } catch (error) {
    const status = error.message === "Cloud URL already exists" ? 409 : 500;
    return NextResponse.json({ error: error.message || "Failed to create cloud URL" }, { status });
  }
}

export async function PATCH(request) {
  try {
    if (!hasValidOrigin(request)) {
      return NextResponse.json({ error: "CSRF validation failed" }, { status: 403 });
    }

    const body = await request.json();
    const { id, status } = body;
    let lastChecked = body?.lastChecked ?? null;

    if (lastChecked) {
      const date = new Date(lastChecked);
      if (Number.isNaN(date.getTime()) || date > new Date()) {
        lastChecked = null;
      }
    }

    if (!id) {
      return NextResponse.json({ error: "Valid cloud URL id is required" }, { status: 400 });
    }

    if (status && !VALID_STATUSES.has(status)) {
      return NextResponse.json({ error: "Invalid status value" }, { status: 400 });
    }

    const updatedUrls = await writeCloudUrls((cloudUrls) => {
      const index = cloudUrls.findIndex((entry) => entry.id === id);
      if (index === -1) throw new Error("Cloud URL not found");

      if (status) cloudUrls[index].status = status;
      if (lastChecked !== undefined) cloudUrls[index].lastChecked = lastChecked;

      return cloudUrls;
    });

    return NextResponse.json({ success: true, cloudUrls: sanitizeListForResponse(updatedUrls) });
  } catch (error) {
    const statusMap = {
      "Cloud URL not found": 404,
    };
    return NextResponse.json(
      { error: error.message || "Failed to update cloud URL" },
      { status: statusMap[error.message] || 500 }
    );
  }
}

export async function DELETE(request) {
  try {
    if (!hasValidOrigin(request)) {
      return NextResponse.json({ error: "CSRF validation failed" }, { status: 403 });
    }

    const body = await request.json();
    const id = String(body?.id ?? "").trim();

    if (!id) {
      return NextResponse.json({ error: "Valid cloud URL id is required" }, { status: 400 });
    }

    const updated = await writeCloudUrls((cloudUrls) => {
      const index = cloudUrls.findIndex((entry) => entry.id === id);
      if (index === -1) {
        throw new Error("Cloud URL not found");
      }
      // It is now valid for cloudUrls to be empty — the dashboard treats that
      // as "cloud not configured".
      return cloudUrls.filter((entry) => entry.id !== id);
    });

    return NextResponse.json({ cloudUrls: sanitizeListForResponse(updated) });
  } catch (error) {
    const statusMap = {
      "Valid cloud URL id is required": 400,
      "Cloud URL not found": 404,
    };
    return NextResponse.json({ error: error.message || "Failed to delete cloud URL" }, { status: statusMap[error.message] || 500 });
  }
}
