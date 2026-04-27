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

  it("renders a Morph page shell that describes the raw proxy bundle", async () => {
    const source = await fs.readFile(morphPagePath, "utf8");

    expect(source).toContain("Configure the dedicated Morph proxy bundle");
    expect(source).toContain("separately from provider selection");
    expect(source).toContain("Proxy-only integration");
    expect(source).toContain("/api/morph/apply");
    expect(source).toContain("/api/morph/compact");
    expect(source).toContain("/api/morph/embeddings");
    expect(source).toContain("/api/morph/rerank");
    expect(source).toContain("/api/morph/warpgrep");
  });
});
