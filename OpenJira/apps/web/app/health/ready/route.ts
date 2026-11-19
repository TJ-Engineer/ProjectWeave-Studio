import { databaseReady } from "@vibe/database";
import { buildInformation } from "@vibe/observability";
import { NextResponse } from "next/server";

export async function GET(): Promise<NextResponse> {
  const ready = await databaseReady();
  return NextResponse.json(
    { status: ready ? "ready" : "not-ready", build: buildInformation() },
    { status: ready ? 200 : 503 },
  );
}
