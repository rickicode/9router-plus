import { SITE_NAME } from "@/shared/constants/site";

export const metadata = {
  title: {
    default: `Combos - ${SITE_NAME}`,
    template: `%s - ${SITE_NAME}`,
  },
};
export default function CombosLayout({ children }) { return children; }
