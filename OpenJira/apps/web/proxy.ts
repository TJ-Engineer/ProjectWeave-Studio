import { type NextRequest, NextResponse } from "next/server";

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

export function proxy(request: NextRequest) {
  const parent = /^00-([0-9a-f]{32})-[0-9a-f]{16}-([0-9a-f]{2})$/i.exec(
    request.headers.get("traceparent") ?? "",
  );
  const traceId =
    parent?.[1] && !/^0+$/.test(parent[1])
      ? parent[1].toLowerCase()
      : randomHex(16);
  const flags = parent?.[2]?.toLowerCase() ?? "01";
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-trace-id", traceId);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-trace-id", traceId);
  response.headers.set("traceparent", `00-${traceId}-${randomHex(8)}-${flags}`);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
