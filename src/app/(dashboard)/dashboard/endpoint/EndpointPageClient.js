"use client";

import { useRouter, useSearchParams } from "next/navigation";
import PropTypes from "prop-types";
import { SegmentedControl } from "@/shared/components";
import MainTab from "./components/MainTab";
import CloudTab from "./components/CloudTab";

export default function EndpointPageClient({ machineId }) {
  const searchParams = useSearchParams();
  const router = useRouter();

  const tabFromUrl = searchParams.get("tab");
  const activeTab = tabFromUrl === "cloud" ? "cloud" : "main";

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    const params = new URLSearchParams(searchParams);
    if (value === "cloud") {
      params.set("tab", "cloud");
    } else {
      params.delete("tab");
    }
    const nextQuery = params.toString();
    router.push(nextQuery ? `/dashboard?${nextQuery}` : "/dashboard", { scroll: false });
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
