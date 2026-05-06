import { SITE_NAME } from "@/shared/constants/site";

export const metadata = {
  title: {
    default: `Profile - ${SITE_NAME}`,
    template: `%s - ${SITE_NAME}`,
  },
};
export default function ProfileLayout({ children }) { return children; }
