"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import ProfileSettingsContent from "@/shared/components/settings/ProfileSettingsContent";

export { ProfileSettingsContent };

export default function ProfilePage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard/settings");
  }, [router]);

  return null;
}
