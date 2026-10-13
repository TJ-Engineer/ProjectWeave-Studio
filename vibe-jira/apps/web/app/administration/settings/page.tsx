import { getAdministrationSettings } from "@vibe/database";
import { notFound, redirect } from "next/navigation";
import { AdministrationSettings } from "@/components/administration-settings";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AdministrationSettingsPage() {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  if (identity.organizationRole !== "ADMIN") notFound();
  return (
    <AdministrationSettings
      currentUserId={identity.id}
      displayName={identity.displayName}
      initialView={await getAdministrationSettings(identity)}
    />
  );
}
