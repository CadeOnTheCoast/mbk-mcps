import { NextRequest, NextResponse } from "next/server";
import { verifyAuthCode, verifyPkceS256 } from "@/lib/oauth";

// Token endpoint. Supports two grants:
//   authorization_code (+ PKCE) — what Claude.ai's connector uses
//   client_credentials          — kept for direct/script access
// In both cases the issued access token is the MCP_CLIENT_SECRET, which the
// /api/mcp route validates as the Bearer token.

function form(headers?: Record<string, string>) {
  return { headers: { "Access-Control-Allow-Origin": "*", ...(headers ?? {}) } };
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    },
  });
}

export async function POST(req: NextRequest) {
  const expected = process.env.MCP_CLIENT_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "server_error", error_description: "MCP_CLIENT_SECRET not configured" }, { status: 500, ...form() });
  }

  let body: Record<string, string>;
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    body = Object.fromEntries(new URLSearchParams(await req.text()));
  } else {
    body = await req.json().catch(() => ({}));
  }

  // Client secret may arrive in the body (client_secret_post) or as HTTP Basic.
  let clientSecret = body.client_secret;
  const authz = req.headers.get("authorization");
  if (!clientSecret && authz?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authz.slice(6), "base64").toString("utf8");
      clientSecret = decoded.slice(decoded.indexOf(":") + 1);
    } catch {
      /* ignore */
    }
  }

  const grantType = body.grant_type;

  const issue = () =>
    NextResponse.json(
      { access_token: expected, token_type: "Bearer", expires_in: 86400, scope: "mcp" },
      form()
    );

  if (grantType === "authorization_code") {
    const code = body.code;
    const verifier = body.code_verifier;
    const redirectUri = body.redirect_uri;
    if (!code || !verifier) {
      return NextResponse.json({ error: "invalid_request", error_description: "code and code_verifier required" }, { status: 400, ...form() });
    }
    const payload = verifyAuthCode(code);
    if (!payload) {
      return NextResponse.json({ error: "invalid_grant", error_description: "authorization code invalid or expired" }, { status: 400, ...form() });
    }
    if (redirectUri && redirectUri !== payload.ru) {
      return NextResponse.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, { status: 400, ...form() });
    }
    if (!verifyPkceS256(verifier, payload.cc)) {
      return NextResponse.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, { status: 400, ...form() });
    }
    // PKCE proves the caller initiated the flow; the client secret confirms org authorization.
    if (clientSecret !== expected) {
      return NextResponse.json({ error: "invalid_client" }, { status: 401, ...form() });
    }
    return issue();
  }

  if (grantType === "client_credentials") {
    if (clientSecret !== expected) {
      return NextResponse.json({ error: "invalid_client" }, { status: 401, ...form() });
    }
    return issue();
  }

  return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400, ...form() });
}
