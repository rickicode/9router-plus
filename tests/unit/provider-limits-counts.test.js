import { describe, expect, it } from "vitest";

import { getConnectionCentralizedStatus, getConnectionFilterStatus } from "../../src/lib/connectionStatus.js";

function filterVisibleConnections(connections = [], searchQuery = "", statusFilter = "all") {
  const query = searchQuery.trim().toLowerCase();

  return connections.filter((conn) => {
    const status = getConnectionFilterStatus(conn);
    const matchesSearch = !query || [conn.provider, conn.name, conn.displayName, conn.email, conn.connectionName, conn.id]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
    const matchesStatus = statusFilter === "all" || status === statusFilter;

    return matchesSearch && matchesStatus;
  });
}

function getCanonicalStatusCounts(connections = []) {
  return connections.reduce((counts, connection) => {
    const status = getConnectionCentralizedStatus(connection);

    switch (status) {
      case "eligible":
      case "exhausted":
      case "blocked":
      case "unknown":
      case "disabled":
        counts[status] += 1;
        break;
      default:
        counts.unknown += 1;
        break;
    }

    return counts;
  }, {
    eligible: 0,
    exhausted: 0,
    blocked: 0,
    unknown: 0,
    disabled: 0,
  });
}

describe("provider limits summary counts", () => {
  it("keeps badge totals based on search results instead of the active status filter", () => {
    const supportedConnections = [
      { id: "eligible-1", provider: "codex", authType: "oauth", routingStatus: "eligible", usageSnapshot: "{}" },
      { id: "eligible-2", provider: "codex", authType: "oauth", routingStatus: "eligible", usageSnapshot: "{}" },
      { id: "exhausted-1", provider: "codex", authType: "oauth", quotaState: "exhausted" },
      { id: "blocked-1", provider: "codex", authType: "oauth", authState: "invalid" },
      { id: "disabled-1", provider: "codex", authType: "oauth", isActive: false },
    ];

    const searchMatchedConnections = filterVisibleConnections(supportedConnections, "codex", "all");
    const visibleConnections = filterVisibleConnections(searchMatchedConnections, "", "eligible");

    expect(visibleConnections.map((connection) => connection.id)).toEqual(["eligible-1", "eligible-2"]);
    expect(getCanonicalStatusCounts(searchMatchedConnections)).toEqual({
      eligible: 2,
      exhausted: 1,
      blocked: 1,
      unknown: 0,
      disabled: 1,
    });
  });


  it("keeps the eligible filter result count aligned with the eligible summary badge", () => {
    const supportedConnections = [
      { id: "eligible-1", provider: "codex", authType: "oauth", routingStatus: "eligible", usageSnapshot: "{}" },
      { id: "eligible-2", provider: "codex", authType: "oauth", quotaState: "ok", authState: "ok", healthStatus: "healthy", usageSnapshot: "{}" },
      { id: "exhausted-1", provider: "codex", authType: "oauth", quotaState: "exhausted" },
      { id: "blocked-1", provider: "codex", authType: "oauth", authState: "invalid" },
    ];

    const searchMatchedConnections = filterVisibleConnections(supportedConnections, "", "all");
    const visibleEligibleConnections = filterVisibleConnections(searchMatchedConnections, "", "eligible");
    const canonicalStatusCounts = getCanonicalStatusCounts(searchMatchedConnections);

    expect(visibleEligibleConnections).toHaveLength(canonicalStatusCounts.eligible);
    expect(visibleEligibleConnections.map((connection) => connection.id)).toEqual(["eligible-1", "eligible-2"]);
  });

  it("treats usage-supported oauth connections without snapshots as unknown instead of eligible", () => {
    const supportedConnections = [
      { id: "missing-snapshot", provider: "codex", authType: "oauth", routingStatus: "eligible" },
      { id: "eligible-with-snapshot", provider: "codex", authType: "oauth", routingStatus: "eligible", usageSnapshot: "{}" },
    ];

    expect(getCanonicalStatusCounts(supportedConnections)).toEqual({
      eligible: 1,
      exhausted: 0,
      blocked: 0,
      unknown: 1,
      disabled: 0,
    });

    expect(filterVisibleConnections(supportedConnections, "", "eligible").map((connection) => connection.id)).toEqual(["eligible-with-snapshot"]);
  });
});
