import { timingSafeEqual } from "crypto";

// Shared secrets accepted as OAuth client secrets and as Bearer tokens.
//   MCP_CLIENT_SECRET  — the staff/org secret (labelled "staff")
//   MCP_USER_SECRETS   — extra per-user secrets for people outside the org,
//                        as "label:secret,label:secret". Remove an entry and
//                        redeploy to revoke that one person.
// The token endpoint issues the presented secret back as the access token, so
// a revoked secret stops working on the next request.

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function secrets(): Array<[label: string, secret: string]> {
  const out: Array<[string, string]> = [];
  const staff = process.env.MCP_CLIENT_SECRET;
  if (staff) out.push(["staff", staff]);
  for (const entry of (process.env.MCP_USER_SECRETS ?? "").split(",")) {
    const i = entry.indexOf(":");
    if (i <= 0) continue;
    const label = entry.slice(0, i).trim();
    const secret = entry.slice(i + 1).trim();
    if (label && secret) out.push([label, secret]);
  }
  return out;
}

/** Returns the label of the matching secret, or null if it matches none. */
export function identifySecret(presented: string | undefined | null): string | null {
  if (!presented) return null;
  for (const [label, secret] of secrets()) {
    if (safeEqual(presented, secret)) return label;
  }
  return null;
}
