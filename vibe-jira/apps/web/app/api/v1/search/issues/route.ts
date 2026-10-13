import { issueSearchQuerySchema } from "@vibe/contracts";
import { searchIssues } from "@vibe/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  enforceRateLimit,
  handleApiError,
  requireIdentity,
} from "@/lib/api";

const repeatedFields = [
  "projects",
  "issueTypes",
  "statuses",
  "statusCategories",
  "priorities",
  "assignees",
  "reporters",
  "labels",
  "parents",
] as const;

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    await enforceRateLimit(request, "search.issues", 120, 60, identity.id);
    const parameters = new URL(request.url).searchParams;
    const input: Record<string, string> = Object.fromEntries(parameters);
    for (const field of repeatedFields) {
      const values = parameters.getAll(field);
      if (values.length > 0) input[field] = values.join(",");
    }
    const page = await searchIssues(
      identity,
      issueSearchQuerySchema.parse(input),
    );
    return NextResponse.json(page, {
      headers: {
        "cache-control": "no-store",
        "x-correlation-id": requestId,
      },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
