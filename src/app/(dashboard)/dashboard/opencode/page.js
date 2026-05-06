import OpenCodePageClient from "./OpenCodePageClient";

import { pageTitle } from "@/shared/constants/site";

export const metadata = { title: pageTitle("OpenCode") };

export default function OpenCodePage() {
  return <OpenCodePageClient />;
}
