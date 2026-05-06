import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from "@/shared/constants/providers";
import { SITE_NAME } from "@/shared/constants/site";

export async function generateMetadata({ params }) {
  const { id } = await params;
  const provider = OAUTH_PROVIDERS[id] || APIKEY_PROVIDERS[id];
  return {
    title: {
      absolute: `${provider?.name || id} - ${SITE_NAME}`,
    },
  };
}

export default function ProviderDetailLayout({ children }) { return children; }
