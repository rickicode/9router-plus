import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const sidebarPath = path.resolve(import.meta.dirname, "../../src/shared/components/Sidebar.js");
const morphPagePath = path.resolve(
  import.meta.dirname,
  "../../src/app/(dashboard)/dashboard/morph/MorphPageClient.js"
);
const dashboardNavigationPath = path.resolve(
  import.meta.dirname,
  "../../src/shared/constants/dashboardNavigation.js"
);

describe("Morph dashboard nav shell", () => {
  it("adds Morph as a top-level sidebar destination", async () => {
    const source = await fs.readFile(dashboardNavigationPath, "utf8");

    expect(source).toContain('{ href: "/dashboard/morph", label: "Morph", icon: "route" }');
  });

  it("keeps the shared pathname-based active-state logic intact", async () => {
    const source = await fs.readFile(dashboardNavigationPath, "utf8");

    expect(source).toContain("return pathname.startsWith(href);");
    expect(source).toContain('if (href === "/dashboard/endpoint")');
    expect(source).toContain('if (href === DASHBOARD_SETTINGS_NAV_ITEM.href)');
  });

  it("sidebar still delegates active-state checks to the shared navigation helper", async () => {
    const source = await fs.readFile(sidebarPath, "utf8");

    expect(source).toContain("isDashboardNavItemActive(pathname, href)");
    expect(source).toContain("isDashboardMediaKindActive(pathname, kind.id)");
  });

  it("renders a Morph page shell that exposes the browser Morph base URL", async () => {
    const source = await fs.readFile(morphPagePath, "utf8");

    expect(source).toContain("Manage Morph key rotation and use the browser-specific base URL below");
    expect(source).toContain("Browser Morph base URL");
    expect(source).toContain("append `/morphllm` when pointing clients");
    expect(source).not.toContain("Back to Settings");
    expect(source).toContain('className="flex w-full max-w-6xl flex-col gap-5"');
    expect(source).toContain("/morphllm/v1/chat/completions");
    expect(source).toContain("/morphllm/v1/compact");
    expect(source).toContain("/morphllm/v1/embeddings");
    expect(source).toContain("/morphllm/v1/rerank");
    expect(source).toContain("/morphllm/v1/models");
    expect(source).toContain("window.location.origin");
    expect(source).toContain("/morphllm");
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
