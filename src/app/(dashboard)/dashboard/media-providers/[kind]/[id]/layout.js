import { AI_PROVIDERS } from "@/shared/constants/providers";

export async function generateMetadata({ params }) {
  const { id } = await params;
  const provider = AI_PROVIDERS[id];
  return { title: provider?.name || id };
}

export default function MediaProviderDetailLayout({ children }) { return children; }
