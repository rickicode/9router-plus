import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.js"],
    exclude: [
      "**/node_modules/**",
      "../.claude/worktrees/**",
      "../.worktrees/**",
      ".claude/worktrees/**",
      ".worktrees/**",
      "**/.claude/worktrees/**",
      "**/.worktrees/**",
    ],
    // Suppress noisy console output from handlers under test
    silent: false,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "../src"),
      // Resolve open-sse/* imports to the actual local package
      "open-sse": resolve(__dirname, "../open-sse"),
      // Resolve @/* imports to src directory
      "@": resolve(__dirname, "../src"),
    },
  },
});
