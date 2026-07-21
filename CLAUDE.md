# vikunja-mcp — architecture & conventions

An MCP server that exposes a [Vikunja](https://vikunja.io) instance to an LLM agent over the
Model Context Protocol. Read this before changing anything.

## Why this project exists — mistakes we do NOT repeat

It replaces third-party Vikunja MCP servers that share the defects below. Every rule in this
document traces back to one of them:

1. **Raw payloads.** They return full Vikunja API objects (views, buckets, blur hashes,
   expanded owners). One real project listing measured ~95k characters. → We project to lean
   DTOs and never leak a raw API object to the model.
2. **No pagination.** They issue a single request and drop the `x-pagination-*` headers,
   silently truncating lists at 50. → The client follows `x-pagination-total-pages` and returns
   everything.
3. **Global-id identity.** They address tasks by the global numeric `id`; the UI shows a
   project key (`INFRA-41`). Agents and humans end up naming different tasks. → Tasks are
   addressed by key everywhere. A bare number is rejected unless passed as an explicit `id`
   escape hatch.
4. **Dead foundation.** They depend on the abandoned `node-vikunja` client. → Zero task-domain
   dependencies; we call REST directly with the global `fetch`.
5. **Mega-tool permissions.** One `vikunja_tasks` tool with a `subcommand` argument means an
   MCP client cannot allow reads without also allowing writes and deletes. → One tool per
   operation, read and write cleanly separated.

## Architecture

Layered; dependencies point downward only. No layer imports from a layer above it.

```
src/
  index.ts        transport + tool registration (thin; no business logic)
  config.ts       env -> Config (VIKUNJA_URL, VIKUNJA_API_TOKEN); the ONLY host we talk to
  client.ts       REST over fetch; auth; pagination; error mapping
  resolver.ts     project-key <-> global id (e.g. INFRA-41 -> 301); caches project identifiers
  projection.ts   raw Vikunja objects -> lean DTOs; markdown <-> html
  types.ts        lean DTOs (LeanTask, LeanProject, ...) shared across layers
  tools/          one file per tool; each a thin adapter over the layers below
```

`index.ts` and `tools/*` contain no HTTP and no domain logic — they validate input, call
`client`/`resolver`/`projection`, and shape output. All Vikunja knowledge lives in
`client`/`resolver`/`projection`.

## Tool surface

One operation per tool. Read tools carry `readOnlyHint`; write tools do not. Never merge
operations behind a `subcommand`/`mode` argument — it defeats per-tool permissions, which is a
primary reason this project exists.

| tool | kind | notes |
|------|------|-------|
| `vikunja_list_projects` | read | keys + titles only |
| `vikunja_list_tasks` | read | filters: project, done, search; lean rows |
| `vikunja_get_task` | read | input: key (`INFRA-41`) or `{ id }` |
| `vikunja_list_labels` | read | for label mapping |
| `vikunja_create_task` | write | markdown description accepted |
| `vikunja_update_task` | write | partial fields incl. `done` |
| `vikunja_complete_task` | write | convenience over update |
| `vikunja_comment_task` | write | |
| `vikunja_delete_task` | write | isolated so it can be denied on its own |

## Invariants

- **Lean by default.** Every tool returns the minimum an agent needs; no raw API objects.
  Default `LeanTask`: `{ ref, id, title, done, priority?, due?, labels }`.
- **Keys, not ids.** Anything a human or agent references is a key (`INFRA-41`). The global
  `id` is an escape hatch only.
- **One host.** Outbound network is limited to `config.baseUrl`. No telemetry, no other fetch
  targets. This is a hard rule — it is the project's privacy guarantee.
- **All pages.** List operations exhaust pagination; they never silently truncate.
- **Descriptions.** Vikunja stores HTML. Convert markdown -> HTML on write; verify the exact
  behavior against the running server before trusting it.

## Code conventions

- TypeScript strict, ESM, Node >= 20. `fetch` is global — no HTTP client libraries.
- Small modules, named exports, no default exports.
- Errors: throw `Error` with an actionable message; `index.ts` maps it to an MCP tool error.
  Never swallow a non-2xx response silently.
- Format and lint with Biome; typecheck with tsc. `npm run check` must pass before a task is
  considered done.

## Vikunja REST notes

These describe **v2.3.0**, the version this server targets. Behaviour below has been read out of
`go-vikunja/vikunja` at that tag; check the tag again before trusting any of it on a newer
server. (Known drift: v2.4.0 adds `GET /projects/{project}/tasks/by-index/{index}`, which would
collapse the whole key-resolution dance below into one request.)

- A task has both `id` (global PK) and `index` (per-project sequence). The key is
  `<project.identifier>-<index>`, e.g. `INFRA-41`. An empty project identifier renders the key
  as `#<index>`.
- A task also carries a ready-made `identifier` (`"VMCP-2"`), so the key does not have to be
  assembled from the project. On a read it is never empty: `setIdentifier` fills in `#<index>`
  itself when the project has no identifier, so `identifier || fallback` never takes the
  fallback and `identifier === ""` never detects anything. On an update response the server does
  not fill it in at all (`setIdentifier` is not called on that path), so it comes back only if
  the request payload carried it — which the read-modify-write in `client.updateTask` happens to
  do. Do not lean on that: derive the ref from `index` rather than from an update response.
- There is no "get by key" endpoint. Resolve: project by identifier -> `GET /tasks` with
  `filter=project_id = <id>` (paginated) -> match `index` -> global id. Cache the project ->
  identifier map. Do NOT use `GET /projects/{id}/tasks`: it still answers, but v2.3.0 documents
  only `PUT` on that path. Do NOT use `GET /projects/{id}/views/{view}/tasks` either — it applies
  the view's own filter (the default List view hides done tasks) and silently returns a subset.
- Pagination headers: `x-pagination-total-pages`, `x-pagination-result-count`.
  `max_items_per_page` (`service.maxitemsperpage`) defaults to **50**, not 1000; a larger
  `per_page` is clamped without an error and the page count is derived from the clamped value,
  so paging is mandatory. Asking for 1000 is still right — it resolves to the largest page a
  given instance allows. An empty collection reports `x-pagination-total-pages: 0` — fetch page
  1, then walk up to the total.
- `POST /tasks/{id}` is **not** a partial update. The handler binds the body onto an empty
  struct and writes a fixed 14-column set, then explicitly re-zeroes every field the payload
  omitted (`tasks.go`, the block commented "Mergo does ignore nil values"): `description`,
  `done`, `priority`, `due_date`, `start_date`, `end_date`, `repeat_after`, `hex_color`,
  `percent_done`, `is_favorite`. Assignees and reminders are replaced wholesale, and an empty
  list deletes them. So `{ done: true }` alone strips the task bare — read the task and send it
  back with the patch applied, which is what `client.updateTask` does. The genuine partial path
  (an explicit `fields` list) is reachable only from `POST /tasks/bulk`.
- Project update differs again: it writes a fixed column set, so omitted numeric fields (e.g.
  `position`) are zeroed — but an omitted `description` is preserved. Send the fields you intend
  to keep.

## Checks

```
npm run check   # biome check + tsc --noEmit
npm run build
```
