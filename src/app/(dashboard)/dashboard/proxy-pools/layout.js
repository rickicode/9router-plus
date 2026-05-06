import { SITE_NAME } from "@/shared/constants/site";

export const metadata = {
  title: {
    default: `Proxy Pools - ${SITE_NAME}`,
    template: `%s - ${SITE_NAME}`,
  },
};
export default function ProxyPoolsLayout({ children }) { return children; }
