import { SITE_NAME } from "@/shared/constants/site";

export const metadata = {
  title: {
    default: `Add Provider - ${SITE_NAME}`,
    template: `%s - ${SITE_NAME}`,
  },
};
export default function NewProviderLayout({ children }) { return children; }
