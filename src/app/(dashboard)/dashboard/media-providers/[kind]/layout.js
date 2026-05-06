import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { SITE_NAME } from "@/shared/constants/site";

export async function generateMetadata({ params }) {
  const { kind } = await params;
  const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kind);
  return {
    title: {
      absolute: `${kindConfig?.label || kind} - ${SITE_NAME}`,
    },
  };
}

export default function MediaKindLayout({ children }) { return children; }
