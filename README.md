# vikunja-mcp

A lean, identifier-native [Model Context Protocol](https://modelcontextprotocol.io) server for [Vikunja](https://vikunja.io).

It exists because the existing Vikunja MCP servers share three problems:

- **Token bloat** — they return raw Vikunja API objects. Listing a single project can run to ~95k characters and blow an agent's context budget.
- **Opaque identity** — they address tasks by the global numeric `id`, while the Vikunja UI shows a project-scoped key (`INFRA-41`). Agents and humans end up talking about different numbers.
- **Coarse permissions** — they expose one mega-tool with a `subcommand` argument, so an MCP client cannot allow read operations without also allowing writes and deletes.

`vikunja-mcp` fixes all three: compact payloads, tasks addressed by their project key (`INFRA-41`), and one tool per operation split cleanly into read and write.

## Install & configure

```
npx @epodivilov/vikunja-mcp
```

Configuration is environment-only:

| var | required | default |
|-----|----------|---------|
| `VIKUNJA_API_TOKEN` | yes | — |
| `VIKUNJA_URL` | no | `http://localhost:3456/api/v1` |

Register it (Claude Code example):

```json
{
  "mcpServers": {
    "vikunja": {
      "command": "npx",
      "args": ["-y", "@epodivilov/vikunja-mcp"],
      "env": {
        "VIKUNJA_URL": "http://localhost:3456/api/v1",
        "VIKUNJA_API_TOKEN": "..."
      }
    }
  }
}
```

## Tools

Read (safe to allow-list):

- `vikunja_list_projects`
- `vikunja_list_tasks` — filter by project / done / free-text search
- `vikunja_get_task` — by key (`INFRA-41`) or explicit global id
- `vikunja_list_labels`

Write (keep gated):

- `vikunja_create_task`
- `vikunja_update_task`
- `vikunja_complete_task`
- `vikunja_comment_task`
- `vikunja_delete_task`

Because each operation is its own tool, you can grant read access permanently while still
reviewing every write:

```json
{
  "permissions": {
    "allow": [
      "mcp__vikunja__vikunja_list_projects",
      "mcp__vikunja__vikunja_list_tasks",
      "mcp__vikunja__vikunja_get_task",
      "mcp__vikunja__vikunja_list_labels"
    ]
  }
}
```

## Privacy

The server makes network requests to `VIKUNJA_URL` and nowhere else — no telemetry, no
third-party calls. It is intentionally small so you can read every line that touches your token.

## Development

```
npm install
npm run check   # biome + tsc + tests
npm run build
```

The published package runs on Node >= 22 (`engines.node`) — that is plain compiled JS in `dist`.
Working on the source needs Node >= 22.18 (`devEngines.runtime`), because `npm test` runs the
TypeScript suite through Node's built-in type stripping, which is only enabled by default from
22.18 onward. On anything older the suite fails with `ERR_UNKNOWN_FILE_EXTENSION`.

See [CLAUDE.md](./CLAUDE.md) for architecture and conventions.

## License

MIT
