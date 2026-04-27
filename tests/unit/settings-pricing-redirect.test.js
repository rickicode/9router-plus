import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const appDir = path.resolve(import.meta.dirname, "../../src/app/dashboard/settings");

describe("unified settings page module", () => {
  it("adds the consolidated settings route entry and legacy pricing redirect shim", async () => {
    const [settingsPage, pricingShim] = await Promise.all([
      fs.readFile(path.join(appDir, "page.js"), "utf8"),
      fs.readFile(path.join(appDir, "pricing/page.js"), "utf8"),
    ]);

    expect(settingsPage).toContain('import SettingsPageClient from "./SettingsPageClient"');
    expect(settingsPage).toContain("export default function SettingsPage()");
    expect(pricingShim).toContain('import { redirect } from "next/navigation"');
    expect(pricingShim).toContain('redirect("/dashboard/settings")');
  });
});
