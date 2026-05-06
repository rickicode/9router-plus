import { SITE_NAME } from "@/shared/constants/site";

export const metadata = {
  title: {
    default: `Providers - ${SITE_NAME}`,
    template: `%s - ${SITE_NAME}`,
  },
};
export default function ProvidersLayout({ children }) { return children; }
