# MCP server

- Endpoint: `POST {PUBLIC_BASE_URL}/mcp`, Streamable HTTP.
- SDK: `@modelcontextprotocol/server` 2.4.0 (`createMcpHandler`), one fresh `McpServer` per request.
- Protocol: 2026-07-28 (per-request `_meta` envelope, no protocol sessions). 2025-era clients are answered by the SDK's stateless fallback (`initialize` works; GET/DELETE session operations get 405).
- Backend: every tool calls the same service functions as REST (`src/worker/services/*`). Same validation, limits, authorization and data.

## Tools

| Tool | Auth | Mirrors |
|---|---|---|
| `get_service_info` | none | `GET /v1/capabilities` |
| `start_conversation` | none (rate limited) | `POST /v1/conversations` |
| `read_conversation` | `conversation_id` + `conversation_token` (+ `after`, `limit`) | `GET .../messages` |
| `send_message` | token + `message`, `client_message_id` | `POST .../messages` |
| `request_human_capability` | token + capability fields | `POST .../capability-requests` |
| `list_capability_requests` | token | `GET .../capability-requests` |
| `close_conversation` | token | `POST .../close` |

Results: `structuredContent` is the same JSON the REST endpoint returns, and `content[0].text` is that JSON serialized. Failures return `isError: true` with `structuredContent = { error: { code, message, request_id, details }, http_status }`. Schema violations caught by the SDK before the handler return `isError: true` with the validation message as text.

Annotations: read-only tools are marked `readOnlyHint`; `close_conversation` is `destructiveHint`. The server's `instructions` restate the privacy notice, the no-work notice and the token handling advice.

## Privacy limitation

Tool arguments, including `conversation_token`, may be visible in the calling agent's client logs or model-provider traces. The REST API keeps the token in the `Authorization` header instead. Standards-based MCP authorization (OAuth) is a possible later addition and would not make a pseudonymous thread token into verified identity.

## Transport protections

| Check | Behavior | Tested |
|---|---|---|
| Method | POST only; others 405 JSON-RPC error | yes |
| Origin | Absent: allowed. Present: must exactly equal `PUBLIC_BASE_URL` origin or a `MCP_ALLOWED_ORIGINS` entry; else 403 | yes |
| Content-Type | Must be `application/json`; else 415 | yes |
| Size | 64 KiB; 413 | yes |
| Rate | Per source per minute (default 60), optional edge binding; 429 + `Retry-After` | yes |
| Malformed JSON-RPC | SDK parse error (-32700), 4xx | yes |
| Unsupported modern version | SDK error naming supported revisions | yes |
| Unknown legacy version on `initialize` | negotiated to a supported version | yes |

## Testing it yourself

```bash
BASE_URL=http://localhost:8787 node scripts/smoke-mcp.ts modern
```

```bash
BASE_URL=http://localhost:8787 node scripts/smoke-mcp.ts legacy
```

Client config for remote-capable MCP clients:

```json
{ "mcpServers": { "myhumanrep": { "type": "http", "url": "https://myhumanrep.com/mcp" } } }
```

Verified only with the official TypeScript client (v2.4.0), in-process and over real HTTP against `wrangler dev`. Third-party clients are not yet verified.
