import { SITE_NAME } from "@/shared/constants/site";

export const metadata = {
  title: {
    default: `Translator - ${SITE_NAME}`,
    template: `%s - ${SITE_NAME}`,
  },
};
export default function TranslatorLayout({ children }) { return children; }
