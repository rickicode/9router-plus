import MitmPageClient from "./MitmPageClient";

import { pageTitle } from "@/shared/constants/site";

export const metadata = { title: pageTitle("MITM Proxy") };

export default function MitmPage() {
  return <MitmPageClient />;
}
