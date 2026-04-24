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
      <div className="flex gap-1 border-b border-white/10 mb-6 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 relative whitespace-nowrap transition-colors ${
              activeTab === tab ? "text-primary" : "text-text-muted hover:text-text"
            }`}
          >
            {tab}
            {activeTab === tab && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-blue-500 to-violet-500" />
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
