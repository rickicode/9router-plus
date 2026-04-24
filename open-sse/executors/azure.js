import { DefaultExecutor } from "./default.js";

export class AzureExecutor extends DefaultExecutor {
  constructor() {
    super("azure");
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const azureEndpoint = credentials?.providerSpecificData?.azureEndpoint
      || process.env.AZURE_ENDPOINT
      || "https://api.openai.com";

    // Security validation (SSRF protection)
    if (!azureEndpoint || !azureEndpoint.startsWith("http")) {
      throw new Error("Invalid Azure endpoint URL. Must start with http:// or https://");
    }

    try {
      const url = new URL(azureEndpoint);
      const hostname = url.hostname.toLowerCase();

      if (
        hostname === "localhost"
        || hostname === "127.0.0.1"
        || hostname.startsWith("127.")
        || hostname.startsWith("192.168.")
        || hostname.startsWith("10.")
        || hostname.startsWith("172.16.")
        || hostname.startsWith("172.17.")
        || hostname.startsWith("172.18.")
        || hostname.startsWith("172.19.")
        || hostname.startsWith("172.20.")
        || hostname.startsWith("172.21.")
        || hostname.startsWith("172.22.")
        || hostname.startsWith("172.23.")
        || hostname.startsWith("172.24.")
        || hostname.startsWith("172.25.")
        || hostname.startsWith("172.26.")
        || hostname.startsWith("172.27.")
        || hostname.startsWith("172.28.")
        || hostname.startsWith("172.29.")
        || hostname.startsWith("172.30.")
        || hostname.startsWith("172.31.")
        || hostname.startsWith("169.254.")
        || hostname === "[::1]"
        || hostname === "0.0.0.0"
      ) {
        throw new Error("Invalid endpoint: internal network addresses are not allowed");
      }

      if (url.protocol !== "https:") {
        throw new Error("Azure endpoint must use HTTPS");
      }
    } catch (error) {
      if (error.message.includes("internal network") || error.message.includes("HTTPS")) {
        throw error;
      }

      throw new Error("Invalid Azure endpoint URL format");
    }

    const apiVersion = credentials?.providerSpecificData?.apiVersion
      || process.env.AZURE_API_VERSION
      || "2024-10-01-preview";

    // Deployment name with fallback to model (upstream behavior)
    const deployment = credentials?.providerSpecificData?.deployment
      || model
      || process.env.AZURE_DEPLOYMENT
      || "gpt-4";

    const endpoint = azureEndpoint.replace(/\/$/, "");
    return `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${apiVersion}`;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    const apiKey = credentials?.apiKey
      || credentials?.accessToken
      || process.env.OPENAI_API_KEY;

    if (apiKey) {
      headers["api-key"] = apiKey;
    }

    const organization = credentials?.providerSpecificData?.organization
      || process.env.AZURE_ORGANIZATION;

    if (organization) {
      headers["OpenAI-Organization"] = organization;
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    return body;
  }
}
