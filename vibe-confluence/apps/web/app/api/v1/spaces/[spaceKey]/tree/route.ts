import { pageTreeQuerySchema, spaceKeySchema } from "@knowledge/contracts";
import { listPageTree } from "@knowledge/database";
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
    const url = new URL(request.url);
    const input = pageTreeQuerySchema.parse({
      parentId: url.searchParams.get("parentId") || null,
      cursor: url.searchParams.get("cursor") || null,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    return NextResponse.json(
      await listPageTree(await requireIdentity(), spaceKey, input),
      { headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}
