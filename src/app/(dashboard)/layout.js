import { DashboardLayout } from "@/shared/components";
import { SITE_NAME } from "@/shared/constants/site";

export const metadata = {
  title: {
    template: `%s - ${SITE_NAME}`,
    default: `Dashboard - ${SITE_NAME}`,
  },
};

export default function DashboardRootLayout({ children }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}

