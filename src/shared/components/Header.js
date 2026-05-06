"use client";

import { usePathname, useRouter } from "next/navigation";
import { useMemo } from "react";
import Link from "next/link";
import PropTypes from "prop-types";
import ProviderIcon from "@/shared/components/ProviderIcon";
import HeaderMenu from "@/shared/components/HeaderMenu";
import { getDashboardPageInfo } from "@/shared/constants/dashboardNavigation";
import { clearAllDashboardQueries } from "@/shared/hooks";
import { translate } from "@/i18n/runtime";

export default function Header({ onMenuClick, showMenuButton = true }) {
  const pathname = usePathname();
  const router = useRouter();

  const pageInfo = useMemo(() => getDashboardPageInfo(pathname), [pathname]);
  const { title, description, icon, breadcrumbs } = pageInfo;

  const handleLogout = async () => {
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (res.ok) {
        clearAllDashboardQueries();
        router.replace("/login");
      }
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

  return (
    <header
      key={pathname}
      className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--color-border)] bg-[color:color-mix(in_srgb,var(--color-bg)_80%,transparent)] px-8 py-5"
    >
      {/* Mobile menu button */}
      <div className="flex items-center gap-3 lg:hidden">
        {showMenuButton && (
          <button
            onClick={onMenuClick}
            className="text-[var(--color-text-main)] transition-colors hover:text-[var(--color-primary)]"
          >
            <span className="material-symbols-outlined">menu</span>
          </button>
        )}
      </div>

      {/* Page title with breadcrumbs - desktop */}
      <div className="hidden lg:flex flex-col">
        {breadcrumbs.length > 0 ? (
          <div className="flex items-center gap-2">
            {breadcrumbs.map((crumb, index) => (
              <div
                key={`${crumb.label}-${crumb.href || "current"}`}
                className="flex items-center gap-2"
              >
                {index > 0 && (
                  <span className="material-symbols-outlined text-base text-[var(--color-text-muted)]">
                    chevron_right
                  </span>
                )}
                {crumb.href ? (
                  <Link
                    href={crumb.href}
                    className="text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-primary)]"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <div className="flex items-center gap-2">
                    {crumb.image && (
                      <ProviderIcon
                        src={crumb.image}
                        alt={crumb.label}
                        size={28}
                        className="object-contain rounded max-w-[28px] max-h-[28px]"
                        fallbackText={crumb.label.slice(0, 2).toUpperCase()}
                      />
                    )}
                    <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-text-main)]">
                      {translate(crumb.label)}
                    </h1>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : title ? (
          <div>
            <div className="flex items-center gap-2">
              {icon && (
                <span className="material-symbols-outlined text-2xl text-[var(--color-primary)]">
                  {icon}
                </span>
              )}
              <h1 className="text-2xl font-semibold tracking-tight">
                {translate(title)}
              </h1>
            </div>
            {description && (
              <p className="text-sm text-[var(--color-text-muted)]">
                {translate(description)}
              </p>
            )}
          </div>
        ) : null}
      </div>

      {/* Right actions - consolidated into dropdown menu */}
      <div className="flex items-center ml-auto">
        <HeaderMenu onLogout={handleLogout} />
      </div>
    </header>
  );
}

Header.propTypes = {
  onMenuClick: PropTypes.func,
  showMenuButton: PropTypes.bool,
};
