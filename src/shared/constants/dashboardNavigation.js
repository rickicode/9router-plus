import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from "./config";
import { MEDIA_PROVIDER_KINDS, AI_PROVIDERS } from "./providers";

export const DASHBOARD_PRIMARY_NAV_ITEMS = [
  { href: "/dashboard/endpoint", label: "Endpoint", icon: "api" },
  { href: "/dashboard/providers", label: "Providers", icon: "dns" },
  { href: "/dashboard/combos", label: "Combos", icon: "layers" },
  { href: "/dashboard/usage", label: "Usage", icon: "bar_chart" },
  { href: "/dashboard/quota", label: "Quota Tracker", icon: "data_usage" },
  { href: "/dashboard/mitm", label: "MITM", icon: "security" },
  { href: "/dashboard/cli-tools", label: "CLI Tools", icon: "terminal" },
  { href: "/dashboard/opencode", label: "OpenCode", icon: "extension" },
  { href: "/dashboard/morph", label: "Morph", icon: "route" },
];

export const DASHBOARD_SYSTEM_NAV_ITEMS = [
  { href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },
];

export const DASHBOARD_DEBUG_NAV_ITEMS = [
  { href: "/dashboard/console-log", label: "Console Log", icon: "terminal" },
  { href: "/dashboard/translator", label: "Translator", icon: "translate" },
];

export const DASHBOARD_SETTINGS_NAV_ITEM = {
  href: "/dashboard/settings",
  label: "Settings",
  icon: "settings",
};

export const DASHBOARD_MEDIA_PROVIDERS_NAV_ITEM = {
  href: "/dashboard/media-providers",
  label: "Media Providers",
  icon: "perm_media",
};

export const DASHBOARD_STATIC_PAGE_INFO = [
  {
    match: (pathname) => pathname === "/dashboard" || pathname === "/dashboard/endpoint",
    info: {
      title: "Endpoint",
      description: "API endpoint configuration",
      icon: "api",
      breadcrumbs: [],
    },
  },
  {
    match: (pathname) => pathname === "/dashboard/providers",
    info: {
      title: "Providers",
      description: "Manage your AI provider connections",
      icon: "dns",
      breadcrumbs: [],
    },
  },
  {
    match: (pathname) => pathname === "/dashboard/providers/new",
    info: {
      title: "Add Provider",
      description: "Create a new provider connection",
      icon: "add_circle",
      breadcrumbs: [
        { label: "Providers", href: "/dashboard/providers" },
        { label: "Add Provider" },
      ],
    },
  },
  {
    match: (pathname) => pathname === "/dashboard/combos",
    info: {
      title: "Combos",
      description: "Model combos with fallback",
      icon: "layers",
      breadcrumbs: [],
    },
  },
  {
    match: (pathname) => pathname === "/dashboard/usage",
    info: {
      title: "Usage & Analytics",
      description: "Monitor your API usage, token consumption, and request logs",
      icon: "bar_chart",
      breadcrumbs: [],
    },
  },
  {
    match: (pathname) => pathname === "/dashboard/quota",
    info: {
      title: "Quota Tracker",
      description: "Track and manage your API quota limits",
      icon: "data_usage",
      breadcrumbs: [],
    },
  },
  {
    match: (pathname) => pathname === "/dashboard/mitm",
    info: {
      title: "MITM Proxy",
      description: "Intercept CLI tool traffic and route through 9Router",
      icon: "security",
      breadcrumbs: [],
    },
  },
  {
    match: (pathname) => pathname === "/dashboard/cli-tools",
    info: {
      title: "CLI Tools",
      description: "Configure CLI tools",
      icon: "terminal",
      breadcrumbs: [],
    },
  },
  {
    match: (pathname) => pathname === "/dashboard/opencode",
    info: {
      title: "OpenCode",
      description: "Configure the OpenCode control plane and preview the local sync bundle",
      icon: "extension",
      breadcrumbs: [],
    },
  },
  {
    match: (pathname) => pathname === "/dashboard/morph",
    info: {
      title: "Morph",
      description: "Monitor Morph routing usage and request activity",
      icon: "route",
      breadcrumbs: [],
    },
  },
  {
    match: (pathname) => pathname === "/dashboard/proxy-pools",
    info: {
      title: "Proxy Pools",
      description: "Manage your proxy pool configurations",
      icon: "lan",
      breadcrumbs: [],
    },
  },
  {
    match: (pathname) => pathname === "/dashboard/settings" || pathname === "/dashboard/profile",
    info: {
      title: "Settings",
      description: "Manage your preferences",
      icon: "settings",
      breadcrumbs: [],
    },
  },
  {
    match: (pathname) => pathname === "/dashboard/settings/pricing",
    info: {
      title: "Settings",
      description: "Manage your preferences",
      icon: "settings",
      breadcrumbs: [],
    },
  },
  {
    match: (pathname) => pathname === "/dashboard/translator",
    info: {
      title: "Translator",
      description: "Debug translation flow between formats",
      icon: "translate",
      breadcrumbs: [],
    },
  },
  {
    match: (pathname) => pathname === "/dashboard/console-log",
    info: {
      title: "Console Log",
      description: "Live server console output",
      icon: "monitor",
      breadcrumbs: [],
    },
  },
  {
    match: (pathname) => pathname === "/dashboard/basic-chat",
    info: {
      title: "Basic Chat",
      description: "Test chat flows directly from the dashboard",
      icon: "chat",
      breadcrumbs: [],
    },
  },
];

export const EMPTY_DASHBOARD_PAGE_INFO = { title: "", description: "", breadcrumbs: [] };

export function isDashboardNavItemActive(pathname, href) {
  if (!pathname || !href) return false;
  if (href === "/dashboard/endpoint") {
    return pathname === "/dashboard" || pathname.startsWith("/dashboard/endpoint");
  }
  if (href === DASHBOARD_SETTINGS_NAV_ITEM.href) {
    return pathname === "/dashboard/profile" || pathname.startsWith("/dashboard/settings");
  }
  if (href === DASHBOARD_MEDIA_PROVIDERS_NAV_ITEM.href) {
    return pathname.startsWith(DASHBOARD_MEDIA_PROVIDERS_NAV_ITEM.href);
  }
  return pathname.startsWith(href);
}

export function isDashboardMediaKindActive(pathname, kindId) {
  if (!pathname || !kindId) return false;
  return pathname.startsWith(`${DASHBOARD_MEDIA_PROVIDERS_NAV_ITEM.href}/${kindId}`);
}

export function getDashboardPageInfo(pathname) {
  if (!pathname) return EMPTY_DASHBOARD_PAGE_INFO;

  const mediaDetailMatch = pathname.match(/^\/dashboard\/media-providers\/([^/]+)\/([^/]+)$/);
  if (mediaDetailMatch) {
    const kindId = mediaDetailMatch[1];
    const providerId = mediaDetailMatch[2];
    const kindConfig = MEDIA_PROVIDER_KINDS.find((kind) => kind.id === kindId);
    const provider = AI_PROVIDERS[providerId];
    return {
      title: provider?.name || providerId,
      description: "",
      breadcrumbs: [
        { label: DASHBOARD_MEDIA_PROVIDERS_NAV_ITEM.label, href: `/dashboard/media-providers/${kindId}` },
        { label: kindConfig?.label || kindId, href: `/dashboard/media-providers/${kindId}` },
        { label: provider?.name || providerId, image: `/providers/${providerId}.png` },
      ],
    };
  }

  const mediaKindMatch = pathname.match(/^\/dashboard\/media-providers\/([^/]+)$/);
  if (mediaKindMatch) {
    const kindId = mediaKindMatch[1];
    const kindConfig = MEDIA_PROVIDER_KINDS.find((kind) => kind.id === kindId);
    return {
      title: kindConfig?.label || kindId,
      description: `Manage your ${kindConfig?.label || kindId} providers`,
      icon: kindConfig?.icon || DASHBOARD_MEDIA_PROVIDERS_NAV_ITEM.icon,
      breadcrumbs: [],
    };
  }

  const providerMatch = pathname.match(/^\/dashboard\/providers\/([^/]+)$/);
  if (providerMatch) {
    const providerId = providerMatch[1];
    const provider = OAUTH_PROVIDERS[providerId] || APIKEY_PROVIDERS[providerId];
    if (provider) {
      return {
        title: provider.name,
        description: "",
        breadcrumbs: [
          { label: "Providers", href: "/dashboard/providers" },
          { label: provider.name, image: `/providers/${provider.id}.png` },
        ],
      };
    }
  }

  const staticMatch = DASHBOARD_STATIC_PAGE_INFO.find((entry) => entry.match(pathname));
  return staticMatch?.info || EMPTY_DASHBOARD_PAGE_INFO;
}
