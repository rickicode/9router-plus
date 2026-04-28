import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const sidebarPath = path.resolve(import.meta.dirname, "../../src/shared/components/Sidebar.js");
const morphPagePath = path.resolve(
  import.meta.dirname,
  "../../src/app/(dashboard)/dashboard/morph/MorphPageClient.js"
);

describe("Morph dashboard nav shell", () => {
  it("adds Morph as a top-level sidebar destination", async () => {
    const source = await fs.readFile(sidebarPath, "utf8");

    expect(source).toContain('{ href: "/dashboard/morph", label: "Morph", icon: "route" }');
  });

  it("keeps the shared pathname-based active-state logic intact", async () => {
    const source = await fs.readFile(sidebarPath, "utf8");

    expect(source).toContain("return pathname.startsWith(href);");
    expect(source).toContain('if (href === "/dashboard/endpoint")');
  });

  it("renders a Morph page shell that exposes the browser Morph base URL", async () => {
    const source = await fs.readFile(morphPagePath, "utf8");

    expect(source).toContain("Manage Morph key rotation and use the browser-specific base URL below");
    expect(source).toContain("Browser Morph base URL");
    expect(source).toContain("append `/morph` when pointing clients");
    expect(source).not.toContain("Back to Settings");
    expect(source).toContain('className="flex w-full max-w-6xl flex-col gap-5"');
    expect(source).toContain("/api/morph/apply");
    expect(source).toContain("/api/morph/compact");
    expect(source).toContain("/api/morph/embeddings");
    expect(source).toContain("/api/morph/rerank");
    expect(source).toContain("/api/morph/warpgrep");
    expect(source).toContain("window.location.origin");
    expect(source).toContain("/morph");
  });

  it("renders a dedicated isolated Morph usage workspace", async () => {
    const source = await fs.readFile(morphPagePath, "utf8");

    expect(source).toContain('{ value: "usage", label: "Usage" }');
    expect(source).toContain("Isolated Morph usage");
    expect(source).toContain("Review Morph-only requests, token flow, and estimated credits.");
    expect(source).toContain("Official Morph pricing basis");
    expect(source).toContain("By email");
  });
});
