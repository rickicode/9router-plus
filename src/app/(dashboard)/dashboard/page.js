import { getMachineId } from "@/shared/utils/machine";
import EndpointPageClient from "./endpoint/EndpointPageClient";
import { pageTitle } from "@/shared/constants/site";

export const metadata = { title: pageTitle("Endpoint") };

export default async function DashboardPage() {
  const machineId = await getMachineId();
  return <EndpointPageClient machineId={machineId} />;
}
