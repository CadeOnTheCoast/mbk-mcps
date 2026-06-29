import { NextResponse } from "next/server";
import { EAClient } from "@/lib/ea-client";
import { TOOLS, callTool } from "@/lib/tools";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001").replace(/\/$/, "");

function unauthorized() {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer realm="MBK EveryAction MCP", resource_metadata="${SITE_URL}/.well-known/oauth-authorization-server"`,
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function rpcError(id: unknown, code: number, message: string) {
  return NextResponse.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { headers: corsHeaders() }
  );
}

function rpcOk(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id, result }, { headers: corsHeaders() });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };
}

// Keys whose values are safe to log in the clear. Everything else (note
// bodies, custom-field values, etc.) is reduced to a length so constituent
// PII and meeting content never land in logs.
const LOGGABLE_ARG_KEYS = new Set([
  "vanId", "firstName", "lastName", "email", "phone", "query", "limit",
  "contactTypeName", "contactTypeId", "date", "resultCodeId", "resultCodeName",
  "activistCode", "activistCodeId", "customFieldId", "noteCategory",
]);

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (LOGGABLE_ARG_KEYS.has(k)) {
      out[k] = typeof v === "string" && v.length > 60 ? `<${v.length} chars>` : v;
    } else if (typeof v === "string") {
      out[k] = `<${v.length} chars>`;
    } else if (v != null) {
      out[k] = "<redacted>";
    }
  }
  return out;
}

function logEvent(evt: Record<string, unknown>) {
  // One JSON line per event -> shows up in Vercel's Logs tab and `vercel logs`.
  try {
    console.log(JSON.stringify({ t: new Date().toISOString(), ...evt }));
  } catch {
    /* never let logging throw */
  }
}

function getClient(): EAClient {
  const apiKey = process.env.EVERYACTION_API_KEY;
  const appName = process.env.EVERYACTION_APP_NAME;
  if (!apiKey || !appName) throw new Error("EVERYACTION_API_KEY and EVERYACTION_APP_NAME must be set");
  return new EAClient({
    apiKey,
    appName,
    mode: process.env.EVERYACTION_MODE ?? "1",
    baseUrl: process.env.EVERYACTION_BASE_URL,
  });
}

// Claude.ai hits GET first to check connectivity -- return auth challenge
export async function GET() {
  return unauthorized();
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function POST(req: Request) {
  // ---------- auth ----------
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return unauthorized();

  const token = authHeader.slice(7);
  const expected = process.env.MCP_CLIENT_SECRET;
  if (!expected || token !== expected) {
    logEvent({ evt: "auth_rejected" });
    return unauthorized();
  }

  // ---------- parse JSON-RPC ----------
  let rpc: any;
  try {
    rpc = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  const { id, method, params } = rpc ?? {};

  // Notifications have no id -- acknowledge silently
  if (id === undefined && typeof method === "string") {
    return new Response(null, { status: 202 });
  }

  // ---------- dispatch ----------
  try {
    switch (method) {
      case "initialize":
        return rpcOk(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mbk-everyaction-mcp", version: "1.0.0" },
        });

      case "tools/list":
        return rpcOk(id, { tools: TOOLS });

      case "tools/call": {
        const toolName = params?.name as string;
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        const client = getClient();
        const startedAt = Date.now();
        try {
          const result = await callTool(toolName, args, client);
          // callTool returns { content: [...], isError? }; treat isError as a failed action.
          const r = result as { isError?: boolean; content?: Array<{ text?: string }> };
          const failed = r?.isError === true;
          logEvent({
            evt: "tool_call",
            tool: toolName,
            ok: !failed,
            ms: Date.now() - startedAt,
            args: redactArgs(args),
            ...(failed ? { err: r.content?.[0]?.text?.slice(0, 300) ?? "error" } : {}),
          });
          return rpcOk(id, result);
        } catch (e: any) {
          logEvent({
            evt: "tool_call",
            tool: toolName,
            ok: false,
            ms: Date.now() - startedAt,
            args: redactArgs(args),
            err: e?.message ?? "error",
          });
          throw e;
        }
      }

      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e: any) {
    logEvent({ evt: "rpc_error", method, err: e?.message ?? "Internal error" });
    return rpcError(id, -32603, e?.message ?? "Internal error");
  }
}
