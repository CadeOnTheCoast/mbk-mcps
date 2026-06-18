import { NextResponse } from "next/server";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001").replace(/\/$/, "");

export async function GET() {
  return NextResponse.json(
    {
      issuer: SITE_URL,
      authorization_endpoint: `${SITE_URL}/authorize`,
      token_endpoint: `${SITE_URL}/api/mcp/oauth/token`,
      grant_types_supported: ["authorization_code", "client_credentials"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
      scopes_supported: ["mcp"],
    },
    { headers: { "Access-Control-Allow-Origin": "*" } }
  );
}
