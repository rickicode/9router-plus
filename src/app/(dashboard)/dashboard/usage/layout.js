import { SITE_NAME } from "@/shared/constants/site";

export const metadata = {
  title: {
    default: `Usage & Analytics - ${SITE_NAME}`,
    template: `%s - ${SITE_NAME}`,
  },
};
export default function UsageLayout({ children }) { return children; }
