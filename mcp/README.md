# ProbeLab as a tool for agents (MCP)

Two ways in, one tool catalogue:

- **HTTP** — `POST https://probelab.beyondles.ai/api/mcp`. Stateless, JSON answers.
  Two credentials, never both in one request (`400 ambiguous_credential`):
  - `x-api-key: probelab_…` — a key created in the Lab's settings.
  - `Authorization: Bearer <on-behalf token>` — what Beyondles HorAIzon and
    other Labs use. The platform issues the token (`POST /api/on-behalf/token`
    with the caller's own service key, `audience: "probelab"`); it lives five
    minutes and names the organisation and, where there is one, the person and
    the agent. Nobody pastes a key between products.
- **stdio** — this folder. A thin bridge for Claude Desktop / Claude Code that
  forwards `tools/list` and `tools/call` to the HTTP endpoint. It has no tools
  of its own and no database access.

## Run the bridge

```bash
cd mcp && npm ci
PROBELAB_URL=https://probelab.beyondles.ai PROBELAB_API_KEY=probelab_… node server.mjs --list
```

`--list` prints the tool names and is at the same time the proof that address
and key are right.

Claude Desktop / Claude Code configuration:

```json
{
  "mcpServers": {
    "probelab": {
      "command": "node",
      "args": ["/path/to/probelab/mcp/server.mjs"],
      "env": { "PROBELAB_URL": "https://probelab.beyondles.ai", "PROBELAB_API_KEY": "probelab_…" }
    }
  }
}
```

## Describe the door

`GET https://probelab.beyondles.ai/api/mcp/describe` with the same credential
lists every tool with its title (German and English), what it does (`access`:
`read`, `write` or `destructive`; `idempotent`; `capability`) and whether the
credential covers it (`available`):

```bash
curl -s https://probelab.beyondles.ai/api/mcp/describe -H "x-api-key: probelab_…" \
  | jq -r '.tools[] | "\(.name) \(.access)"'
```

`tools/list` carries the same markers as MCP `annotations`.

## Where the tools are defined

`src/lib/mcp/catalog.ts` — one entry per `/api/v1` route, each with its marker
(`access`, `idempotent`, `title`, optional `capability`) and a name that starts
with `TOOL_PREFIX` (`src/lib/lab.ts`). Add a tool there for every new API route;
the HTTP endpoint, the describe route and this bridge pick it up automatically.
`tests/unit/tool-catalog.test.ts` refuses a tool without a marker or with a
name that breaks the rule.
