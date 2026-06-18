import { createHmac, createHash, timingSafeEqual } from "crypto";

// Stateless OAuth helpers for the authorization-code + PKCE flow.
// We have no database, so the authorization "code" is a short-lived,
// HMAC-signed token that carries the PKCE challenge and redirect_uri.
// The MCP_CLIENT_SECRET doubles as the HMAC signing key.

function key(): string {
  const secret = process.env.MCP_CLIENT_SECRET;
  if (!secret) throw new Error("MCP_CLIENT_SECRET not configured");
  return secret;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function hmac(payload: string): string {
  return b64url(createHmac("sha256", key()).update(payload).digest());
}

export interface AuthCodePayload {
  cc: string;   // PKCE code_challenge (S256)
  ru: string;   // redirect_uri
  exp: number;  // expiry (epoch ms)
}

/** Mint a signed authorization code carrying the PKCE challenge. */
export function signAuthCode(data: Omit<AuthCodePayload, "exp">, ttlMs = 600_000): string {
  const payload: AuthCodePayload = { ...data, exp: Date.now() + ttlMs };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${hmac(body)}`;
}

/** Verify a signed authorization code; returns the payload or null if invalid/expired. */
export function verifyAuthCode(code: string): AuthCodePayload | null {
  const parts = code.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = hmac(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString("utf8")) as AuthCodePayload;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Verify a PKCE code_verifier against the stored S256 challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = b64url(createHash("sha256").update(verifier).digest());
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}
