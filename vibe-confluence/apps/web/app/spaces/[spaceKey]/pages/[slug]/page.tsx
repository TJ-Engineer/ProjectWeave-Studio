import { pageSlugSchema, spaceKeySchema } from "@knowledge/contracts";
import { resolvePageAlias } from "@knowledge/database";
import { redirect } from "next/navigation";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function PageAliasRedirect({
  params,
}: {
  params: Promise<{ spaceKey: string; slug: string }>;
}) {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  const parameters = await params;
  const resolution = await resolvePageAlias(
    identity,
    spaceKeySchema.parse(parameters.spaceKey),
    pageSlugSchema.parse(parameters.slug),
  );
  redirect(resolution.canonicalPath);
}
