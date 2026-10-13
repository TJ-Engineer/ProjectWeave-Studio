import { buildInformation } from "@vibe/observability";
import { NextResponse } from "next/server";

export function GET(): NextResponse {
  return NextResponse.json({ status: "live", build: buildInformation() });
}
