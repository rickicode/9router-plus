import BasicChatPageClient from "./BasicChatPageClient";

import { pageTitle } from "@/shared/constants/site";

export const metadata = { title: pageTitle("Basic Chat") };

export default function BasicChatPage() {
  return <BasicChatPageClient />;
}