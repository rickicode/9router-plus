import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import ProviderLimits from "../usage/components/ProviderLimits";
import { pageTitle } from "@/shared/constants/site";

export const metadata = { title: pageTitle("Quota Tracker") };

export default function QuotaPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <ProviderLimits />
    </Suspense>
  );
}
