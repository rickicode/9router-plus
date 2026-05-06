import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const fromRepoRoot = (...segments) => path.join(repoRoot, ...segments);

const HANDLERS = [
	fromRepoRoot("cloud", "src", "handlers", "chat.js"),
	fromRepoRoot("cloud", "src", "handlers", "embeddings.js"),
	fromRepoRoot("cloud", "src", "handlers", "verify.js"),
	fromRepoRoot("cloud", "src", "handlers", "health.js"),
];

describe("cloud handlers runtime config migration", () => {
	it("uses getRuntimeConfig in runtime request handlers", () => {
		for (const filePath of HANDLERS) {
			const source = fs.readFileSync(filePath, "utf8");
			expect(source, filePath).toContain("getRuntimeConfig");
		}
	});

	it("keeps machine-data reads in chat and embeddings only for mutation helpers", () => {
		const chat = fs.readFileSync(
			fromRepoRoot("cloud", "src", "handlers", "chat.js"),
			"utf8",
		);
		const embeddings = fs.readFileSync(
			fromRepoRoot("cloud", "src", "handlers", "embeddings.js"),
			"utf8",
		);

		expect(chat).toContain(
			"const data = await getRuntimeConfig(runtimeId, env);",
		);
		expect(embeddings).toContain(
			"const data = await getRuntimeConfig(runtimeId, env);",
		);
		expect(chat).toContain("async function updateCredentials");
		expect(embeddings).toContain("async function updateCredentials");
	});

	it("uses runtime config for chat fallback credential selection", () => {
		const chat = fs.readFileSync(
			fromRepoRoot("cloud", "src", "handlers", "chat.js"),
			"utf8",
		);
		const helperStart = chat.indexOf("async function getProviderCredentials");
		const helperEnd = chat.indexOf(
			"async function markAccountUnavailable",
			helperStart,
		);
		const helperSource = chat.slice(helperStart, helperEnd);

		expect(helperSource).toContain("getRuntimeConfig(runtimeId, env)");
		expect(helperSource).not.toContain("getMachineData(runtimeId, env)");
	});

	it("bounds embeddings fallback retries", () => {
		const embeddings = fs.readFileSync(
			fromRepoRoot("cloud", "src", "handlers", "embeddings.js"),
			"utf8",
		);

		expect(embeddings).toContain(
			"const MAX_RETRIES = Math.max(10, Math.min(providerConnectionCount, 1000))",
		);
		expect(embeddings).toContain("while (retryCount < MAX_RETRIES)");
		expect(embeddings).toContain("Max retries exceeded");
	});

	it("tracks all failed chat fallback credentials", () => {
		const chat = fs.readFileSync(
			fromRepoRoot("cloud", "src", "handlers", "chat.js"),
			"utf8",
		);

		expect(chat).toContain("const excludedConnectionIds = new Set()");
		expect(chat).toContain("excludedConnectionIds.has(credentials?.id)");
		expect(chat).toContain("excludedConnectionIds.add(credentials.id)");
	});
});
