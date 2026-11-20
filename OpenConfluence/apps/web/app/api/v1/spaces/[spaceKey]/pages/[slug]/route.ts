import { pageSlugSchema, spaceKeySchema } from "@knowledge/contracts";
import { resolvePageAlias } from "@knowledge/database";
import { NextResponse } from "next/server";
import { correlationId, handleApiError, requireIdentity } from "@/lib/api";

interface Context {
  params: Promise<{ spaceKey: string; slug: string }>;
}

export async function GET(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  const id = correlationId(request);
  try {
    const parameters = await context.params;
    return NextResponse.json(
      await resolvePageAlias(
        await requireIdentity(),
        spaceKeySchema.parse(parameters.spaceKey),
        pageSlugSchema.parse(parameters.slug),
      ),
      { headers: { "x-correlation-id": id } },
    );
  } catch (error) {
    return handleApiError(error, id);
  }
}
