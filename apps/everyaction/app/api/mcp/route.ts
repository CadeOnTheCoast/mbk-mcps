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
  if (!expected || token !== expected) return unauthorized();

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
        const result = await callTool(toolName, args, client);
        return rpcOk(id, result);
      }

      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e: any) {
    return rpcError(id, -32603, e?.message ?? "Internal error");
  }
}
