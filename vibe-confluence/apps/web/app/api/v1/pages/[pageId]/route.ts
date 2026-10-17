import { getPageWorkspace } from "@knowledge/database";
import { NextResponse } from "next/server";
import { correlationId, handleApiError, requireIdentity } from "@/lib/api";

interface Context {
  params: Promise<{ pageId: string }>;
}

export async function GET(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const id = correlationId(request);
  try {
    const { pageId } = await context.params;
    return NextResponse.json(
      await getPageWorkspace(await requireIdentity(), pageId),
      { headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}
