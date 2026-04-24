import { describe, expect, it } from "vitest";

import { AzureExecutor } from "../../open-sse/executors/azure.js";

describe("AzureExecutor.buildUrl", () => {
  it("rejects localhost and private network endpoints", () => {
    const executor = new AzureExecutor();

    expect(() => executor.buildUrl("gpt-4", true, 0, {
      providerSpecificData: {
        azureEndpoint: "https://127.0.0.1:8080",
        deployment: "test-deployment",
      },
    })).toThrow("Invalid endpoint: internal network addresses are not allowed");

    expect(() => executor.buildUrl("gpt-4", true, 0, {
      providerSpecificData: {
        azureEndpoint: "https://192.168.1.10",
        deployment: "test-deployment",
      },
    })).toThrow("Invalid endpoint: internal network addresses are not allowed");
  });

  it("requires https endpoints", () => {
    const executor = new AzureExecutor();

    expect(() => executor.buildUrl("gpt-4", true, 0, {
      providerSpecificData: {
        azureEndpoint: "http://example.com",
        deployment: "test-deployment",
      },
    })).toThrow("Azure endpoint must use HTTPS");
  });

  it("rejects malformed endpoint URLs", () => {
    const executor = new AzureExecutor();

    expect(() => executor.buildUrl("gpt-4", true, 0, {
      providerSpecificData: {
        azureEndpoint: "https://",
        deployment: "test-deployment",
      },
    })).toThrow("Invalid Azure endpoint URL format");
  });

  it("encodes the deployment name in the URL", () => {
    const executor = new AzureExecutor();

    const url = executor.buildUrl("gpt-4", true, 0, {
      providerSpecificData: {
        azureEndpoint: "https://example.openai.azure.com/",
        deployment: "my deployment/with spaces",
        apiVersion: "2024-10-01-preview",
      },
    });

    expect(url).toBe(
      "https://example.openai.azure.com/openai/deployments/my%20deployment%2Fwith%20spaces/chat/completions?api-version=2024-10-01-preview"
    );
  });
});
