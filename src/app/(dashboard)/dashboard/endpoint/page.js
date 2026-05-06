import { getMachineId } from "@/shared/utils/machine";
import EndpointPageClient from "./EndpointPageClient";
import { pageTitle } from "@/shared/constants/site";

export const metadata = { title: pageTitle("Endpoint") };

export default async function EndpointPage() {
  const machineId = await getMachineId();
  return <EndpointPageClient machineId={machineId} />;
}
