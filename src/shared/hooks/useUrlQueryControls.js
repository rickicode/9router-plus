"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function useUrlQueryControls({
  fallbackPath,
  normalizers = {},
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();
  const targetPath = pathname || fallbackPath;

  const getQueryValue = useCallback((key, defaultValue = "") => {
    const value = searchParams.get(key);
    const normalize = normalizers[key];
    const resolvedValue = value ?? defaultValue;
    return normalize ? normalize(resolvedValue) : resolvedValue;
  }, [normalizers, searchParams]);

  const updateQueryParams = useCallback((updates) => {
    const params = new URLSearchParams(searchParamsString);

    Object.entries(updates).forEach(([key, value]) => {
      const normalize = normalizers[key];
      const nextValue = normalize ? normalize(value) : value;

      if (nextValue === undefined || nextValue === null || nextValue === "") {
        params.delete(key);
      } else {
        params.set(key, nextValue);
      }
    });

    const query = params.toString();
    const nextUrl = query ? `${targetPath}?${query}` : targetPath;

    if (typeof window !== "undefined" && window.location.pathname === targetPath) {
      window.history.replaceState(window.history.state, "", nextUrl);
    }

    router.replace(nextUrl, { scroll: false });
  }, [normalizers, router, searchParamsString, targetPath]);

  return {
    getQueryValue,
    searchParams,
    targetPath,
    updateQueryParams,
  };
}
