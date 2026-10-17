import { compareRevision } from "@knowledge/database";
import { DomainError } from "@knowledge/domain";
import { NextResponse } from "next/server";
import { correlationId, handleApiError, requireIdentity } from "@/lib/api";

interface Context {
  params: Promise<{ pageId: string; number: string }>;
}

export async function GET(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const id = correlationId(request);
  try {
    const { pageId, number: value } = await context.params;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new DomainError(
        "INVALID_REVISION",
        "Revision number is invalid",
        400,
      );
    }
    return NextResponse.json(
      await compareRevision(await requireIdentity(), pageId, number),
      { headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}
