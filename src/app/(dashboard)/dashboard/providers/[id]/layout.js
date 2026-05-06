import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from "@/shared/constants/providers";

export async function generateMetadata({ params }) {
  const { id } = await params;
  const provider = OAUTH_PROVIDERS[id] || APIKEY_PROVIDERS[id];
  return { title: provider?.name || id };
}

export default function ProviderDetailLayout({ children }) { return children; }
