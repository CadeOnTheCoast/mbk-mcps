import { NextRequest, NextResponse } from "next/server";

// Simple client_credentials flow.
// Claude.ai sends: grant_type=client_credentials&client_secret=<secret>
// We validate against MCP_CLIENT_SECRET and return the secret itself as the token.
// The main route then checks Authorization: Bearer <secret> on every call.

export async function POST(req: NextRequest) {
  let body: Record<string, string>;

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    body = Object.fromEntries(new URLSearchParams(text));
  } else {
    body = await req.json().catch(() => ({}));
  }

  const { grant_type, client_secret } = body;
  const expected = process.env.MCP_CLIENT_SECRET;

  if (!expected) {
    return NextResponse.json({ error: "server_error", error_description: "MCP_CLIENT_SECRET not configured" }, { status: 500 });
  }

  if (grant_type !== "client_credentials") {
    return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  if (!client_secret || client_secret !== expected) {
    return NextResponse.json({ error: "invalid_client" }, { status: 401 });
  }

  // Return the secret as the access token -- stateless, no JWT needed.
  // Rotate MCP_CLIENT_SECRET in Vercel to invalidate all sessions.
  return NextResponse.json({
    access_token: expected,
    token_type: "Bearer",
    expires_in: 86400,
    scope: "mcp",
  });
}
