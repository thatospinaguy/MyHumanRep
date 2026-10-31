# MCP Registry publishing

`registry/server.json` describes a **remote-only** server. Version 2.0.0 was **published on 2026-10-31** (owner-approved) and is listed as `com.myhumanrep/agent-contact`. Version 2.1.0 adds the optional `Authorization: Bearer {account_token}` header (agent account, see docs/MCP.md) and the source repository. Bump `version` before any republish.

The registry publishes metadata. It does not make agents discover or call the server automatically.

## Current metadata

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "com.myhumanrep/agent-contact",
  "title": "MyHumanRep: Contact a Human",
  "description": "Two-way human contact and open-ended human capability requests for AI agents.",
  "version": "2.1.0",
  "websiteUrl": "https://myhumanrep.com/for-agents",
  "repository": {
    "url": "https://github.com/thatospinaguy/MyHumanRep",
    "source": "github",
    "id": "1440193267"
  },
  "remotes": [
    {
      "type": "streamable-http",
      "url": "https://myhumanrep.com/mcp",
      "headers": [
        {
          "name": "Authorization",
          "description": "Optional. An agent account token (mhra_...) from POST https://myhumanrep.com/v1/agent-accounts. Keeps credentials out of tool arguments and lets the account find its conversations again after a restart. Omit it to connect without an account.",
          "isRequired": false,
          "isSecret": true,
          "value": "Bearer {account_token}",
          "variables": {
            "account_token": {
              "description": "Agent account token (mhra_...).",
              "isRequired": true,
              "isSecret": true
            }
          }
        }
      ]
    }
  ]
}
```

Validated locally against the official schema (vendored at `registry/server.schema.2025-12-11.json`, fetched from `static.modelcontextprotocol.io` on 2026-10-30):

```bash
npm run validate:registry
```

## Before publishing

1. Production is deployed and these pass against `https://myhumanrep.com`:

```bash
BASE_URL=https://myhumanrep.com node scripts/smoke-mcp.ts modern
```

```bash
BASE_URL=https://myhumanrep.com node scripts/smoke-mcp.ts legacy
```

2. Check whether the registry has a newer schema version and update `$schema` if required.
3. Install the official `mcp-publisher` CLI. Where GitHub release downloads are blocked, build it from the Go module proxy: `GOBIN=/tmp/bin go install github.com/modelcontextprotocol/registry/cmd/publisher@latest` (binary is named `publisher`). Otherwise install it from the `modelcontextprotocol/registry` GitHub releases (it could not be downloaded in the build sandbox) and follow the current quickstart: https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx

## Namespace ownership

`com.myhumanrep/*` is a reverse-DNS namespace. The registry requires proof that you control `myhumanrep.com`, via DNS or HTTP verification. Follow the current `mcp-publisher login dns` (or `http`) instructions; they typically involve publishing a public key in a DNS TXT record or under `/.well-known/` on the domain. Adding a DNS record is a DNS change **(owner approval)**. If you choose HTTP verification, the Worker would need a route serving that file; add it then rather than guessing the path now.

## Publish (owner, after approval)

Run from the `registry/` directory (exact flags per the current CLI help):

```bash
mcp-publisher validate
```

```bash
mcp-publisher publish
```

Bump `version` in `server.json` for every metadata change.

## Manual client setup (works without the registry)

Any MCP client that supports remote Streamable HTTP servers can add:

```json
{
  "mcpServers": {
    "myhumanrep": { "type": "http", "url": "https://myhumanrep.com/mcp" }
  }
}
```

No authentication is needed to connect. Conversation credentials are passed as tool arguments unless the client sends an agent account token as `"headers": { "Authorization": "Bearer mhra_..." }` (see docs/MCP.md).
