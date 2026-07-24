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
  resolver.ts     names -> ids: project keys (INFRA-41 -> 301, cached), label titles, usernames
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
| `vikunja_get_board` | read | project's kanban board as ordered columns of lean tasks + mode; reads the per-view kanban endpoint, both board modes |
| `vikunja_list_members` | read | users a project can assign to, as `{ id, username, name? }`; never an email |
| `vikunja_create_task` | write | markdown description accepted; `assignees` ride along in the create |
| `vikunja_update_task` | write | partial fields incl. `done` |
| `vikunja_complete_task` | write | convenience over update |
| `vikunja_comment_task` | write | |
| `vikunja_move_task` | write | move a task into a named column; manual-bucket boards only, refuses on filter boards |
| `vikunja_label_task` | write | add and/or remove labels on a task; incremental, leaves unnamed labels alone |
| `vikunja_set_task_labels` | write | replace a task's whole label set; `[]` clears it. Split from the above so the wholesale replace can be denied on its own |
| `vikunja_assign_task` | write | additive; already-assigned users produce no write |
| `vikunja_unassign_task` | write | refuses a user who is not assigned — the server would not |
| `vikunja_delete_task` | write | isolated so it can be denied on its own |

## Invariants

- **Lean by default.** Every tool returns the minimum an agent needs; no raw API objects.
  Default `LeanTask`: `{ ref, id, title, done, priority?, due?, labels, assignees? }` — assignees
  are usernames, and the field is absent when the task has none.
- **Keys, not ids.** Anything a human or agent references is a key (`INFRA-41`), a label title or
  a username. The global `id` is an escape hatch only — and, being an escape hatch, it is never
  the *stricter* path: a user id on an assign is passed to the server unchecked (see below).
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
- **Archived projects are hidden twice, and only one of them is opt-out.** `GET /projects` drops
  them unless `is_archived=true` is passed — without it the query gets
  `HAVING MAX(all_projects.is_archived) = 0` appended — and a child inherits the flag from an
  archived parent. `client.listProjects` always asks for them, or the resolver would answer a
  valid key with "no project has that key". `GET /tasks` is the harder one: it builds its project
  set from `getRawProjectsForUser` with `getArchived` false and exposes **no parameter** to widen
  it, so an archived project's tasks are absent from the collection no matter what the filter
  says — while `GET /tasks/{id}` returns the very same task. Probed on 2.3.0 with a throwaway
  archived project: `filter=project_id = 14 && index = 1` answered `[]`, `GET /tasks/579` answered
  the task. So a key in an archived project is **not resolvable** on the filter path at all;
  `resolveTask` says so instead of claiming the index does not exist. Writes are **not** uniformly
  refused, so do not assume the archive flag protects anything: updating the project itself is
  refused (see below), but the kanban bucket-move endpoint goes straight through. Probed on 2.3.0
  with a throwaway archived project: `POST /projects/{id}/views/{view}/buckets/{bucket}/tasks`
  moved a task To-Do -> Done and flipped its `done` while the project was archived. This is why
  the archived refusals in `resolver` live only on the *listing* paths: the point is never to be
  stricter than the server, it is that `GET /tasks` answers `[]` — indistinguishable from "this
  project has no tasks" — and that silent lie is what has to be refused. Where the server answers
  honestly, whether by doing the write or by erroring, we pass it through.
- Updating a project writes a fixed column set, so an update that omits `identifier` **erases
  it** — observed live: archiving through a client that PATCHes only `is_archived` left the
  project with `identifier: ""`, silently destroying every task key in it. An archived project
  also refuses further updates, so the repair is unarchive -> set identifier -> archive.
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
- **Labels are a separate resource, not a task field.** `PUT /projects/{id}/tasks` echoes a
  `labels` array it never stores, and `Task.Update` (`POST /tasks/{id}`) never calls
  `UpdateTaskLabels` — the bulk label handler is its only caller. So "just put labels in the write
  payload" is a silent no-op in both directions, and it is also why labels survive the
  read-modify-write in `client.updateTask`. `vikunja_update_task` must keep refusing `labels`
  rather than pretending.
- **`POST /tasks/{taskID}/labels/bulk` reconciles to a set, in one transaction.** Body is
  `{ "labels": [{ "id": 45 }, ...] }` and only `id` is read. `UpdateTaskLabels` deletes the labels
  not passed, then adds the ones missing, inside the session `db.NewSession()` opens — so a bad id
  rolls the deletes back too. Reconciling by set membership is what makes a re-add of a present
  label, or a remove of an absent one, change nothing: idempotence comes from the endpoint rather
  than from swallowing error codes. An empty array is the explicit, documented way to clear every
  label. The 201 body echoes the request's own array, **not** the stored set — read the task back.
  This is read-modify-write over the whole label set and so clobbers a concurrent change, the same
  TOCTOU `client.updateTask` already accepts.
- Per-label `DELETE /tasks/{task}/labels/{label}` on a label the task does not carry answers a
  **bare 403**, not a 404 and not a no-op: `LabelTask.CanDelete` returns false when the relation
  row is missing and the handler renders that as "Forbidden" with no Vikunja error code —
  indistinguishable from a real permission failure. A per-label add is refused with code 8001 when
  it is already there. Both are reasons the label tools diff to a set and use the bulk endpoint
  instead of firing per-label writes; `client.addTaskLabel` remains only for `create_task`.
- **Assignees stick on create, unlike labels.** `PUT /projects/{id}/tasks` runs
  `createTask(..., updateAssignees: true)`, writing them in the task's own transaction, which the
  web handler rolls back on error — so a rejected assignee leaves no task behind and a valid one
  costs no second request. The response is still not the answer: `setTaskAssignees` echoes back
  the `[{ id: n }]` objects the request carried, whose `username` is empty, so projecting it would
  report `assignees: [""]`. Read the task back, as `create-task.ts` already did for labels.
- **The two assignment endpoints are asymmetric, and only one of them tells the truth.**
  `PUT /tasks/{t}/assignees` refuses an already-assigned user (HTTP 400, code 4021) and a user
  without project access (403, code 7003); `DELETE /tasks/{t}/assignees/{u}` is a bare
  `s.Delete(...)` that never checks the assignment exists and answers 200 for a user who was never
  assigned. So the "not assigned" refusal is **ours** to make — `resolver.resolveUnassigneeIds`
  — and the already-assigned skip is ours too, or a 4021 aborts a multi-user call halfway
  through with part of it applied.
- **`GET /projects/{id}/projectusers` is not paginated** (a plain `c.JSON(200, users)`, no
  `x-pagination-*`), and its membership set is wider than the project's direct shares: the owner,
  direct user shares, team shares, and everything inherited by walking up the parent chain. Its
  `s` parameter matches *fuzzily* (ILIKE over name, username **and email**) and must not be used
  to identify a user — list and match locally, as label resolution does. Emails come back blank
  without `s`, but `toLeanUser` drops the field regardless: that invariant is the projection's,
  not the server's.
- **That listing has a hole, which is why a user id is never gated against it.**
  `ListUsersFromProject` seeds its id map with the addressed project's `owner_id` only, while
  access is granted if any *parent's* owner matches — so a parent project's owner can be assigned
  yet is not listed. The house rule is never to be stricter than the server, so a numeric user id
  goes through untouched and the 403 (if any) is the server's to send.
- **Usernames collide case-insensitively.** Uniqueness is a DB index and the comparison is
  case-sensitive on SQLite, so `Alice` and `alice` coexist — the same trap as project identifiers
  and label titles. Report the ambiguity with both ids; never resolve to the first match.
- **An archived project refuses an assignment** — `canDoTaskAssingee` goes through
  `project.CanUpdate` -> `CanWrite`, so `ErrProjectIsArchived` survives, unlike the kanban bucket
  move whose stub project trips the un-archive exemption. Pass that refusal along rather than
  adding a second one. *Listing* the members of an archived project works, so `list-members` uses
  the plain project resolution, not the archived refusal the task listings apply.
- **API-token scopes.** These routes group as `tasks_assignees` (create / delete / read_all) and
  `projects` -> `projectusers`. A token minted before this feature existed may lack them and
  answer 403; that is deployment configuration, not a code defect — re-mint the token.

## Releasing

Versioning and publishing are driven by [Changesets](https://github.com/changesets/changesets).

- **Every PR ships a changeset.** Run `npx changeset add`, pick the bump (patch/minor/major),
  and write a changelog line. CI enforces this: the `check` job runs
  `changeset status --since=origin/main` and fails a PR that changes the package without one.
- **`--empty` is the escape hatch.** For release-irrelevant work (CI, docs, chore, tooling) that
  still touches tracked files, run `npx changeset add --empty` — it records "no version bump" and
  satisfies the gate without inventing a changelog entry.
- **`main` is continuously mergeable; releasing is a separate, deliberate act.** On push to
  `main`, `.github/workflows/release.yml` runs `changesets/action`: while changesets are pending
  it opens/updates a "Version Packages" PR (the accumulated bump + changelog). Merging *that* PR
  is what publishes to npm and cuts the GitHub Release.
- **Publishing uses npm OIDC trusted publishing — no stored `NPM_TOKEN`.** The workflow declares
  `id-token: write` and upgrades to npm ≥ 11.5.1; the registry mints a short-lived token from the
  OIDC claim. Provenance attaches automatically once the repo is public and is silently skipped
  while it is private — do not force it with `NPM_CONFIG_PROVENANCE`, which errors on a private
  repo. The very first publish of the scoped package must be bootstrapped manually before a
  trusted publisher can be attached (npm requires the package to already exist).

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
