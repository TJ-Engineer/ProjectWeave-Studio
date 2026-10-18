import { compareRevision } from "@knowledge/database";
import { NextResponse } from "next/server";
import {
  correlationId,
  handleApiError,
  parsePositiveIntegerPath,
  parseUuidPath,
  requireIdentity,
} from "@/lib/api";

interface Context {
  params: Promise<{ pageId: string; number: string }>;
}

export async function GET(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const id = correlationId(request);
  try {
    const { pageId: pageValue, number: numberValue } = await context.params;
    const pageId = parseUuidPath(pageValue, "pageId");
    const number = parsePositiveIntegerPath(numberValue, "number");
    return NextResponse.json(
      await compareRevision(await requireIdentity(), pageId, number),
      { headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}
