import ConsoleLogClient from "./ConsoleLogClient";

export const metadata = { title: "Console Log" };

// Force dynamic so Next.js standalone build includes the server-side JS file
export const dynamic = "force-dynamic";

export default function ConsoleLogPage() {
  return <ConsoleLogClient />;
}
