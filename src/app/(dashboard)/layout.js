import { DashboardLayout } from "@/shared/components";

export const metadata = {
  title: {
    template: "%s - 9Router",
    default: "Dashboard - 9Router",
  },
};

export default function DashboardRootLayout({ children }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}

