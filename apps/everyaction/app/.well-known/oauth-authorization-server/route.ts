import { NextResponse } from "next/server";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001").replace(/\/$/, "");

export async function GET() {
  return NextResponse.json({
    issuer: SITE_URL,
    token_endpoint: `${SITE_URL}/api/mcp/oauth/token`,
    grant_types_supported: ["client_credentials"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    scopes_supported: ["mcp"],
    response_types_supported: ["token"],
  });
}
