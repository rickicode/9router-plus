import { getMachineId } from "@/shared/utils/machine";
import CLIToolsPageClient from "./CLIToolsPageClient";
import { pageTitle } from "@/shared/constants/site";

export const metadata = { title: pageTitle("CLI Tools") };

export default async function CLIToolsPage() {
  const machineId = await getMachineId();
  return <CLIToolsPageClient machineId={machineId} />;
}
