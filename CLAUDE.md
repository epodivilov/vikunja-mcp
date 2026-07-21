# vikunja-mcp — architecture & conventions

An MCP server that exposes a [Vikunja](https://vikunja.io) instance to an LLM agent over the
Model Context Protocol. Read this before changing anything.

## Why this project exists — mistakes we do NOT repeat

It replaces third-party Vikunja MCP servers that share the defects below. Every rule in this
document traces back to one of them:

1. **Raw payloads.** They return full Vikunja API objects (views, buckets, blur hashes,
   expanded owners). One real project listing measured ~95k characters. → We project to lean
   DTOs and never leak a raw API object to the model. Measured against a live instance:
   39x smaller on a project listing, 10x on a task listing.
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
- There is no "get by key" endpoint, but `index` is filterable: `GET /tasks` with
  `filter=project_id = <id> && index = <n>` answers with exactly that one task, done or not, so
  a key resolves in one request rather than by walking the project's task list. Verified on
  2.3.0. Still match `index` on the result instead of taking row 0 — a build that ignored the
  term would answer with the whole project, and row 0 of that is a different task. Cache the
  identifier -> project map. Do NOT use `GET /projects/{id}/tasks`: it still answers, but v2.3.0
  documents only `PUT` on that path. Do NOT use `GET /projects/{id}/views/{view}/tasks` either —
  it applies the view's own filter (the default List view hides done tasks) and silently returns
  a subset.
- `GET /projects` hides archived projects unless `is_archived=true` is passed: without it the
  query gets `HAVING MAX(all_projects.is_archived) = 0` appended (`project.go` at v2.3.0), and a
  child inherits the flag from an archived parent. The resolver builds its key map from that
  call, so leaving the parameter off answers a valid key with "no project has that key" — a
  false statement the agent cannot work around. `client.listProjects` therefore always asks for
  archived projects; the server refuses writes to them on its own.
- Project identifiers are unique, but the check is case-sensitive: creating a second `VMCP` is
  refused with code 3007, while `vmcp` alongside it is accepted (probed on 2.3.0). Key input has
  to be matched case-insensitively — the UI displays upper-case and an agent will type either —
  and that match can therefore land on two projects. Report it as ambiguous rather than picking
  one.
- **Descriptions are stored verbatim.** The server neither converts markdown nor sanitizes
  HTML — a `<script>` tag round-trips untouched, and raw markdown comes back as raw markdown
  and renders literally in the UI. That is the whole bug: nothing upstream converts, so the
  conversion is ours to do on write. Expect legacy raw-markdown descriptions in existing data.
- **We sanitize on write, because nobody else will.** `markdownToHtml` escapes raw HTML to
  text instead of passing it through, and drops any link scheme outside
  `https? | mailto | # | /`. The markdown reaching it is written by a model that has just read
  text from tasks it does not own, so treat that input as untrusted.
- The editor is TipTap, and its HTML is not the shape you would write by hand: table cells
  wrap content in `<p>`, and a task-list checkbox sits inside a `<label>`, not directly in the
  `<li>`. `turndown-plugin-gfm` alone handles neither — `projection.ts` adds a rule for each.
  Checkbox state is task data; losing it is a bug, not a formatting nit.
- Detecting "is this HTML or legacy markdown" uses an **allowlist** of tags the editor emits.
  A loose `<[a-z]...>` pattern also matches markdown autolinks (`<https://example.com>`,
  `<ev@example.com>`), and turndown deletes the URL when handed one.
- Absent values are zero values, not `null`/omitted: description `""`, `labels: null`,
  `priority: 0`, dates `0001-01-01T00:00:00Z`. A rich-text field cleared in the UI comes back
  as `<p></p>`. Projection normalizes all of these away.
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
npm run check   # biome check + tsc --noEmit + npm test
npm run build
```

Tests live in `test/`, not `src/` — `src` is the build root and `files: ["dist"]` would publish
them. They run through `node --test` on the TypeScript directly, so **development needs Node
22.6+** even though the shipped code still supports the `engines` floor of 20. `tsc` does not
typecheck `test/` (`include: ["src"]`); Biome still lints it.

`projection.ts` is pure, so its edge cases are cheap to pin. Anything learned about the live
server's actual shapes belongs in `test/projection.test.ts` as a case, not in a commit message.
