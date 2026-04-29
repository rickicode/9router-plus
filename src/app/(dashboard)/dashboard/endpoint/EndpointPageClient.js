"use client";

import PropTypes from "prop-types";
import { useUrlQueryControls } from "@/shared/hooks";
import { SegmentedControl } from "@/shared/components";
import MainTab from "./components/MainTab";
import CloudTab from "./components/CloudTab";

export default function EndpointPageClient({ machineId }) {
  const { getQueryValue, updateQueryParams } = useUrlQueryControls({
    fallbackPath: "/dashboard",
  });

  const tabFromUrl = getQueryValue("tab", "");
  const activeTab = tabFromUrl === "cloud" ? "cloud" : "main";

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    updateQueryParams({ tab: value === "cloud" ? "cloud" : null });
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6 flex flex-col gap-6">
        <SegmentedControl
          options={[
            { value: "main", label: "Main" },
            { value: "cloud", label: "Cloud" },
          ]}
          value={activeTab}
          onChange={handleTabChange}
          activeClassName="border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
        />

        {activeTab === "main" && <MainTab machineId={machineId} />}
        {activeTab === "cloud" && <CloudTab />}
      </div>
    </div>
  );
}

EndpointPageClient.propTypes = {
  machineId: PropTypes.string.isRequired,
};
