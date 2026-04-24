"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import MainTab from "./components/MainTab";
import CloudTab from "./components/CloudTab";
import GoProxyTab from "./components/GoProxyTab";

export default function EndpointPageClient({ machineId }) {
  const [activeTab, setActiveTab] = useState("Main");

  const tabs = ["Main", "Cloud", "Go Proxy"];

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Tab Navigation */}
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-[var(--color-border)]">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`relative whitespace-nowrap rounded-t px-4 py-2 text-sm transition-colors ${
              activeTab === tab
                ? "bg-[var(--color-surface)] text-[var(--color-text-main)]"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-alt)] hover:text-[var(--color-text-main)]"
            }`}
          >
            {tab}
            {activeTab === tab && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--color-primary)]" />
            )}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === "Main" && <MainTab machineId={machineId} />}
      {activeTab === "Cloud" && <CloudTab />}
      {activeTab === "Go Proxy" && <GoProxyTab />}
    </div>
  );
}

EndpointPageClient.propTypes = {
  machineId: PropTypes.string.isRequired,
};
