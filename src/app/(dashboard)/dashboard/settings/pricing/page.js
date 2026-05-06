import { redirect } from "next/navigation";

import { pageTitle } from "@/shared/constants/site";

export const metadata = { title: pageTitle("Pricing") };

export default function PricingSettingsRedirectPage() {
  redirect("/dashboard/settings");
}
