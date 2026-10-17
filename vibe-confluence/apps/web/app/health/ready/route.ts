import { getPool } from "@knowledge/database";
import { NextResponse } from "next/server";

export async function GET(): Promise<NextResponse> {
  try {
    await getPool().query("SELECT 1");
    return NextResponse.json({ status: "ready" });
  } catch {
    return NextResponse.json({ status: "not_ready" }, { status: 503 });
  }
}
