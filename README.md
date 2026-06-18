# mbk-mcps

Monorepo for Mobile Baykeeper's hosted MCP servers. Each app in `apps/` is a
standalone Vercel project with its own set of tools.

## Apps

| App | Description | Vercel URL |
|-----|-------------|------------|
| `apps/everyaction` | EveryAction CRM integration | TBD after first deploy |

## Adding a new MCP

1. Copy `apps/everyaction` as a template
2. Replace `lib/ea-client.ts` and `lib/tools.ts` with your integration
3. Set env vars in Vercel
4. Deploy as a new Vercel project
5. Add as a connector in Claude.ai org settings

## Auth model

Each app uses a shared `client_credentials` OAuth flow. Staff configure the
connector once in Claude.ai with the shared client ID and secret. The token
endpoint validates the secret and returns a bearer token. All tool calls require
that token.

Secrets live in Vercel environment variables -- never in code or git.
