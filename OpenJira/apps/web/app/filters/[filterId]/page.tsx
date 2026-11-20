import type { SavedFilterQuery } from "@vibe/contracts";
import { getSavedFilter } from "@vibe/database";
import { notFound, redirect } from "next/navigation";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

function searchUrl(query: SavedFilterQuery): string {
  const parameters = new URLSearchParams();
  for (const [name, value] of [
    ["q", query.q],
    ["createdFrom", query.createdFrom],
    ["createdTo", query.createdTo],
    ["updatedFrom", query.updatedFrom],
    ["updatedTo", query.updatedTo],
    ["sort", query.sort],
    ["direction", query.direction],
  ] as const) {
    if (value) parameters.set(name, value);
  }
  for (const [name, values] of [
    ["projects", query.projects],
    ["issueTypes", query.issueTypes],
    ["statuses", query.statuses],
    ["statusCategories", query.statusCategories],
    ["priorities", query.priorities],
    ["assignees", query.assignees],
    ["reporters", query.reporters],
    ["labels", query.labels],
    ["parents", query.parents],
  ] as const) {
    for (const value of values) parameters.append(name, value);
  }
  return `/search?${parameters.toString()}`;
}

export default async function SavedFilterPage({
  params,
}: {
  params: Promise<{ filterId: string }>;
}) {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  const { filterId } = await params;
  const filter = await getSavedFilter(identity, filterId);
  if (!filter) notFound();
  redirect(searchUrl(filter.query));
}
