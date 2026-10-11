import { databaseReady } from "@vibe/database";
import { NextResponse } from "next/server";

export async function GET(): Promise<NextResponse> {
  const ready = await databaseReady();
  return NextResponse.json(
    { status: ready ? "ready" : "not-ready" },
    { status: ready ? 200 : 503 },
  );
}
