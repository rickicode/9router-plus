import { AI_PROVIDERS } from "@/shared/constants/providers";
import { SITE_NAME } from "@/shared/constants/site";

export async function generateMetadata({ params }) {
  const { id } = await params;
  const provider = AI_PROVIDERS[id];
  return {
    title: {
      absolute: `${provider?.name || id} - ${SITE_NAME}`,
    },
  };
}

export default function MediaProviderDetailLayout({ children }) { return children; }
