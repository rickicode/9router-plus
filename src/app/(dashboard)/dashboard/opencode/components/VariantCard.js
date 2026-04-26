"use client";

import { Badge } from "@/shared/components";
import { cn } from "@/shared/utils/cn";

export default function VariantCard({
  title,
  description,
  selected = false,
  onClick,
  badges = [],
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative w-full overflow-hidden rounded border px-6 py-6 text-left transition-all duration-200 cursor-pointer font-['Berkeley_Mono']",
        active
          ? "border-[#ec4899] bg-[#302c2c] shadow-[0_2px_12px_rgba(236,72,153,0.06)]"
          : "border-[rgba(15,0,0,0.12)] bg-[#201d1d] hover:border-[#ec4899]/40 hover:bg-[#302c2c]"
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[#ec4899]/10 opacity-0 transition-opacity duration-200 group-hover:opacity-100" />

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2 pr-2">
          <div className="text-[16px] font-bold leading-[1.50] text-[#fdfcfc]">{title}</div>
          <div className="text-[14px] leading-[2.00] text-[#9a9898]">{description}</div>
        </div>
        <div className="flex flex-col items-end gap-2.5 pt-0.5">
          {active && <span className="rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-2 py-0.5 text-[14px] text-[#ec4899] font-bold">Selected</span>}
          <span className={cn(
            "material-symbols-outlined text-[20px] transition-colors duration-200",
            active ? "text-[#ec4899]" : "text-[#9a9898] group-hover:text-[#ec4899]/60"
          )}>
            {active ? "radio_button_checked" : "radio_button_unchecked"}
          </span>
        </div>
      </div>

      {badges.length > 0 ? (
        <div className="mt-5 flex flex-wrap gap-2">
          {badges.map((badge, idx) => (
            <span key={idx} className="rounded border border-[rgba(15,0,0,0.12)] bg-[#201d1d] px-2 py-0.5 text-[14px] text-[#9a9898]">
              {badge}
            </span>
          ))}
        </div>
      ) : null}
    </button>
  );
}
