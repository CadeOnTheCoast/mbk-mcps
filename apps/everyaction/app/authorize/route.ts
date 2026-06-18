import { NextRequest, NextResponse } from "next/server";
import { signAuthCode } from "@/lib/oauth";

// OAuth Authorization Endpoint (authorization_code + PKCE).
// No interactive login: this is an org connector whose real gate is the
// client_secret + PKCE verifier required at the token endpoint. We validate
// the request shape, then redirect straight back to the client with a
// short-lived, signed authorization code that carries the PKCE challenge.

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const responseType = p.get("response_type");
  const redirectUri = p.get("redirect_uri");
  const state = p.get("state");
  const codeChallenge = p.get("code_challenge");
  const codeChallengeMethod = p.get("code_challenge_method");

  if (!redirectUri) {
    return NextResponse.json({ error: "invalid_request", error_description: "redirect_uri required" }, { status: 400 });
  }

  // Open-redirect guard: only ever bounce back to Claude's callback host.
  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    return NextResponse.json({ error: "invalid_request", error_description: "malformed redirect_uri" }, { status: 400 });
  }
  if (redirect.protocol !== "https:" || redirect.hostname !== "claude.ai") {
    return NextResponse.json({ error: "invalid_request", error_description: "untrusted redirect_uri" }, { status: 400 });
  }

  const fail = (error: string, desc?: string) => {
    redirect.searchParams.set("error", error);
    if (desc) redirect.searchParams.set("error_description", desc);
    if (state) redirect.searchParams.set("state", state);
    return NextResponse.redirect(redirect.toString());
  };

  if (responseType !== "code") return fail("unsupported_response_type", "only response_type=code is supported");
  if (!codeChallenge || codeChallengeMethod !== "S256") return fail("invalid_request", "S256 PKCE code_challenge required");

  const code = signAuthCode({ cc: codeChallenge, ru: redirectUri });
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);
  return NextResponse.redirect(redirect.toString());
}
