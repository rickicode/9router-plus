import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { getR2Info } from "@/lib/r2BackupClient";

/**
 * GET /api/r2/info - Get R2 storage status from all workers
 */
export async function GET() {
  try {
    const settings = await getSettings();
    const cloudUrls = Array.isArray(settings.cloudUrls) ? settings.cloudUrls : [];
    const eligible = cloudUrls.filter(c => c?.url && c?.secret);

    if (eligible.length === 0) {
      return NextResponse.json({
        configured: false,
        workers: []
      });
    }

    const results = await Promise.allSettled(
      eligible.map(async (entry) => {
        const info = await getR2Info(entry.url, entry.secret);
        return {
          name: entry.name,
          url: entry.url,
          ...info
        };
      })
    );

    const workers = results.map((r, i) => {
      if (r.status === "fulfilled") {
        return { ...r.value, status: "ok" };
      }
      return {
        name: eligible[i].name,
        url: eligible[i].url,
        status: "error",
        error: r.reason?.message || "unknown"
      };
    });

    return NextResponse.json({
      configured: true,
      r2BackupEnabled: settings.r2BackupEnabled || false,
      r2LastBackupAt: settings.r2LastBackupAt || null,
      workers
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
