import SettingsPageClient from "./SettingsPageClient";

import { pageTitle } from "@/shared/constants/site";

export const metadata = { title: pageTitle("Settings") };

export default function SettingsPage() {
  return <SettingsPageClient />;
}
