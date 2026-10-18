import {
  spaceKeySchema,
  spaceMemberPageQuerySchema,
} from "@knowledge/contracts";
import { listSpaceMembers } from "@knowledge/database";
import { NextResponse } from "next/server";
import { correlationId, handleApiError, requireIdentity } from "@/lib/api";

interface Context {
  params: Promise<{ spaceKey: string }>;
}

export async function GET(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const id = correlationId(request);
  try {
    const { spaceKey: value } = await context.params;
    const spaceKey = spaceKeySchema.parse(value);
    const search = new URL(request.url).searchParams;
    const input = spaceMemberPageQuerySchema.parse({
      kind: search.get("kind") ?? undefined,
      query: search.get("query") ?? undefined,
      cursor: search.get("cursor") ?? undefined,
      limit: search.get("limit") ?? undefined,
    });
    return NextResponse.json(
      await listSpaceMembers(await requireIdentity(), spaceKey, input),
      { headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}
