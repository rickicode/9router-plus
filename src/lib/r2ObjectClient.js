import crypto from "node:crypto";

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000];
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function defaultSleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function putObjectWithRetry({
  objectUrl,
  body,
  contentType,
  r2Config = null,
  maxAttempts = 3,
  fetchImpl = fetch,
  sleep = defaultSleep,
  now = () => new Date(),
}) {
  let lastStatus = 0;
  let lastStatusText = "Unknown Error";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const headers = {
      "Content-Type": contentType,
    };
    const signedHeaders = r2Config
      ? signR2Request({
          method: "PUT",
          url: objectUrl,
          body,
          headers,
          r2Config,
          now,
        })
      : headers;
    const response = await fetchImpl(objectUrl, {
      method: "PUT",
      body,
      headers: signedHeaders,
    });

    if (response?.ok) {
      return { ok: true, attempts: attempt };
    }

    lastStatus = Number(response?.status) || 0;
    lastStatusText = response?.statusText || "Unknown Error";

    if (attempt < maxAttempts) {
      const backoffMs = DEFAULT_BACKOFF_MS[attempt - 1] ?? DEFAULT_BACKOFF_MS.at(-1);
      await sleep(backoffMs);
    }
  }

  throw new Error(
    `Failed to PUT R2 object ${objectUrl} after ${maxAttempts} attempts: ${lastStatus} ${lastStatusText}`
  );
}

export function signR2Request({ method, url, body = "", headers = {}, r2Config, now = () => new Date() }) {
  const accessKeyId = String(r2Config?.accessKeyId || "").trim();
  const secretAccessKey = String(r2Config?.secretAccessKey || "").trim();
  const region = String(r2Config?.region || "auto").trim() || "auto";

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Missing required R2 credentials: accessKeyId, secretAccessKey");
  }

  const requestUrl = new URL(url);
  const requestDate = typeof now === "function" ? now() : new Date(now);
  const amzDate = formatAmzDate(requestDate);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body || "");
  const normalizedHeaders = normalizeHeaders({
    ...headers,
    host: requestUrl.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  });
  const signedHeaderNames = Object.keys(normalizedHeaders).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${normalizedHeaders[name]}`)
    .join("\n") + "\n";
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    method.toUpperCase(),
    requestUrl.pathname || "/",
    canonicalQueryString(requestUrl.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = getSigningKey(secretAccessKey, dateStamp, region, "s3");
  const signature = hmacHex(signingKey, stringToSign);

  return {
    ...headers,
    host: requestUrl.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function buildR2ObjectUrl(config, objectKey) {
  const endpoint = String(config?.endpoint || "").replace(/\/$/, "");
  const bucket = String(config?.bucket || "").trim();
  const key = String(objectKey || "").replace(/^\/+/, "");

  if (!endpoint || !bucket || !key) {
    throw new Error("Missing required R2 object URL fields: endpoint, bucket, key");
  }

  return `${endpoint}/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function buildR2BucketProbeUrl(config) {
  const endpoint = String(config?.endpoint || "").replace(/\/$/, "");
  const bucket = String(config?.bucket || "").trim();

  if (!endpoint || !bucket) {
    throw new Error("Missing required R2 configuration fields: endpoint, bucket");
  }

  return `${endpoint}/${encodeURIComponent(bucket)}?max-keys=1&list-type=2`;
}

function normalizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key.toLowerCase(), String(value).trim().replace(/\s+/g, " ")])
  );
}

function canonicalQueryString(searchParams) {
  return [...searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) return leftValue.localeCompare(rightValue);
      return leftKey.localeCompare(rightKey);
    })
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join("&");
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256Hex(value) {
  if (value === undefined || value === null || value === "") return EMPTY_SHA256;
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function hmacHex(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

function getSigningKey(secretAccessKey, dateStamp, region, service) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

function formatAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}
