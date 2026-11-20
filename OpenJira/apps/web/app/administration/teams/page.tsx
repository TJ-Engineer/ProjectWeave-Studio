import { getAdministrationTeams } from "@vibe/database";
import { notFound, redirect } from "next/navigation";
import { TeamsAdministration } from "@/components/teams-administration";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function TeamsPage() {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  if (identity.organizationRole !== "ADMIN") notFound();
  return (
    <TeamsAdministration
      displayName={identity.displayName}
      initialView={await getAdministrationTeams(identity)}
    />
  );
}
