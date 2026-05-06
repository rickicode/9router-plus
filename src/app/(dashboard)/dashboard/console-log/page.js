import ConsoleLogClient from "./ConsoleLogClient";

import { pageTitle } from "@/shared/constants/site";

export const metadata = { title: pageTitle("Console Log") };

// Force dynamic so Next.js standalone build includes the server-side JS file
export const dynamic = "force-dynamic";

export default function ConsoleLogPage() {
  return <ConsoleLogClient />;
}
