import { runDedupedUsageRefreshJob } from "../../../../lib/usageRefreshQueue.js";
import { refreshConnectionUsage } from "@/lib/connectionUsageRefresh.js";

export async function GET(request, { params }) {
  try {
    const { connectionId } = await params;
    const searchParams = new URL(request.url).searchParams;
    const runConnectionTest = searchParams.get("test") === "1";
    const includeMetadata = runConnectionTest || searchParams.get("meta") === "1";

    return await runDedupedUsageRefreshJob(connectionId, async () => {
      const result = await refreshConnectionUsage(connectionId, { runConnectionTest });
      if (includeMetadata) {
        return Response.json({
          usage: result.usage,
          testResult: result.testResult,
          skipped: result.skipped,
        });
      }

      return Response.json(result.usage);
    });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    console.warn(`[Usage] ${error.message}`);
    return Response.json({
      error: error.message,
      ...(error?.testResult ? { testResult: error.testResult } : {}),
    }, { status });
  }
}
