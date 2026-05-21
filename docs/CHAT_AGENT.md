# MedIntel Chat Agent (v2.0) — Operator Notes

The `ProspectingAgent` is the chat-first prospecting surface. PR C ships the
agent core, its tool registry, and the chat API. The React chat UI is PR D;
sub-agents are PR E.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | yes | Anthropic API key (already wired for the existing integration) |
| `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` | yes | Anthropic base URL (already wired) |
| `ANTHROPIC_AGENT_MODEL` | no | Agent model; default `claude-sonnet-4-6` |
| `ANTHROPIC_AGENT_MAX_TOKENS` | no | Max output tokens/turn; default `4096` |
| `ANTHROPIC_AGENT_MAX_TOOL_CALLS_PER_TURN` | no | Tool-loop cap; default `25` |
| `ANTHROPIC_PROMPT_CACHING_ENABLED` | no | Prompt-cache the system prompt; default `true` |
| `MCP_GATEWAY_URL` | no | healthcare-data-mcp live-gateway URL, e.g. `https://medintel-mcp.replit.app/mcp` |
| `MCP_LIVE_GATEWAY_TOKEN` | no | Bearer token for the gateway |
| `AGENT_RATE_LIMIT_PER_USER_PER_DAY` | no | Fallback per-user query cap; default `100` |
| `AGENT_RATE_LIMIT_PER_ACCOUNT_PER_DAY` | no | Fallback per-account cap; default `1000` |

## The Open-Informatics MCP gateway

The agent's 138-tool Open-Informatics catalog comes from a **separate Python
service** — `healthcare-data-mcp` running its `live-gateway`. The agent is
**fail-soft**: if `MCP_GATEWAY_URL` is unset or the gateway is unreachable,
the agent runs with just the database + proprietary tools. No crash, no code
change — it picks the MCP tools up on the next session once the gateway is
online.

### Standing the gateway up on Replit

Replit Autoscale deployments don't run arbitrary Docker sidecars. The
Replit-native pattern is a **separate always-on Repl** (Reserved VM):

1. Fork `ajhcs/healthcare-data-mcp` to the HansenHoldings org.
2. Create a new Repl from that fork. Set its run command to:
   `hc-mcp live-gateway --transport streamable-http --host 0.0.0.0 --port 8020`
3. Deploy it as a **Reserved VM** (always-on). Note its public URL.
4. Generate a 32-byte bearer token; set `MCP_LIVE_GATEWAY_TOKEN` on BOTH the
   gateway Repl and this app.
5. Set `MCP_GATEWAY_URL=https://<gateway-repl>.replit.app/mcp` on this app.
6. Restart the api-server. On the next chat session the agent's tool count
   jumps from ~16 (proprietary + db) to ~150.

Until then the agent is fully usable on free database + proprietary tools.

## Chat API

All routes are RLS-scoped per account.

- `POST   /api/chat/sessions` — create a session → `{ sessionId }`
- `GET    /api/chat/sessions` — list the rep's sessions
- `GET    /api/chat/sessions/:id` — session detail + message history
- `POST   /api/chat/sessions/:id/messages` — send a message; **SSE stream** of
  `token` / `tool_call` / `tool_result` / `prospect` / `usage` / `done` events
- `DELETE /api/chat/sessions/:id` — archive
- `GET    /api/chat/sessions/:id/prospects` — opportunities surfaced in-session

## Tool registry

| Category | Count | Status |
|---|---|---|
| Database + action | 7 | live — reads facilities/signals/equipment/contacts, persists opportunities, drafts outreach (pending only) |
| Proprietary (medintel_*) | 9 | stubs — return `not_implemented`; Phases 2–6 fill them in |
| Open-Informatics MCP | ~138 | live only when the gateway is configured |

## Guardrails

- Every paid tool passes the `PaidSourceGate` dual gate (PR B).
- Every query is rate-limited per user + per account (PR B).
- `draft_outreach` only ever writes a `pending` outreach draft — nothing is
  ever sent. The rep approves every send.
- `db_persist_opportunity` requires a real `facility_id` — no write, no
  prospect, so the agent can't hallucinate a facility into the Inbox.
