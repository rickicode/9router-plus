import { redirect } from "next/navigation";

export const metadata = { title: "Pricing" };

export default function PricingSettingsRedirectPage() {
  redirect("/dashboard/settings");
}
