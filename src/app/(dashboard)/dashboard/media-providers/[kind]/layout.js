import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";

export async function generateMetadata({ params }) {
  const { kind } = await params;
  const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kind);
  return { title: kindConfig?.label || kind };
}

export default function MediaKindLayout({ children }) { return children; }
