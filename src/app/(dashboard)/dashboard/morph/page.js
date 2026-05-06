import MorphPageClient from "./MorphPageClient";

import { pageTitle } from "@/shared/constants/site";

export const metadata = { title: pageTitle("Morph") };

export default function MorphPage() {
  return <MorphPageClient />;
}
