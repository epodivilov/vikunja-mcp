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
| `vikunja_get_task` | read | input: key (`INFRA-41`) or `{ id }`; carries the task's relations as lean refs |
| `vikunja_list_labels` | read | for label mapping; `{ id, title, color? }` |
| `vikunja_get_board` | read | project's kanban board as ordered columns of lean tasks + mode; reads the per-view kanban endpoint, both board modes |
| `vikunja_list_members` | read | users a project can assign to, as `{ id, username, name? }`; never an email |
| `vikunja_list_comments` | read | a task's comments as `LeanComment` rows, bodies as markdown |
| `vikunja_get_comment` | read | one comment, by task + numeric `commentId` |
| `vikunja_create_task` | write | markdown description accepted; `assignees` ride along in the create |
| `vikunja_create_tasks` | write | create many tasks in one project in one call — no native bulk endpoint, so it loops `PUT /projects/{p}/tasks`. Two-phase: resolves the project and every item's labels/assignees first (all-or-nothing; a bad name or empty array throws, writes nothing), then creates in order collecting `{ created, failed }` — the one write tool that reports per-item failure instead of throwing. Labels attach one-by-one after each create, so a created-but-unlabelled task is possible and its failure names the created id |
| `vikunja_update_task` | write | partial fields incl. `done` |
| `vikunja_update_tasks` | write | update many tasks in one call, each with its OWN patch — a heterogeneous read-modify-write loop over `update_task`'s path (`client.updateTask`), NOT the native `POST /tasks/bulk` (which broadcasts one identical `values` and destroys assignees/reminders/favourites). Two-phase like `create_tasks`: resolve every target first via `resolver.resolveTasks` + `client.getTask` (all-or-nothing — an empty list, an item with no field, an unresolvable/ambiguous/archived/nonexistent target, or the same task targeted twice throws and writes nothing; duplicates are a conflict, NOT a coalesce, so never `resolveBulkTargets`), then apply each patch collecting `{ updated, failed }`. Labels/assignees refused per item via `z.strictObject` |
| `vikunja_bulk_update_tasks` | write | one `done`/`priority`/`due` across many tasks, through `POST /tasks/bulk` — one transaction, the API's only genuine partial write. Refuses the whole call when any named task carries assignees or reminders or is a favourite (the endpoint destroys all three), and — only when `done` is being set — when any of them repeats (the completion does not stick) |
| `vikunja_complete_task` | write | convenience over update |
| `vikunja_comment_task` | write | creates a comment; markdown body |
| `vikunja_update_comment` | write | replaces a comment's body; markdown in, HTML stored; `destructiveHint` — no history to recover the old text from |
| `vikunja_move_task` | write | move a task into a named column; manual-bucket boards only, refuses on filter boards |
| `vikunja_label_task` | write | add and/or remove labels on a task; incremental, leaves unnamed labels alone |
| `vikunja_set_task_labels` | write | replace a task's whole label set; `[]` clears it. Split from the above so the wholesale replace can be denied on its own |
| `vikunja_create_label` | write | creates a label; refuses an empty title and one another label already holds — the server accepts both |
| `vikunja_update_label` | write | rename and/or recolour a label; merges onto the whole stored record, since `POST /labels/{id}` zeroes what it omits |
| `vikunja_assign_task` | write | additive; already-assigned users produce no write |
| `vikunja_unassign_task` | write | refuses a user who is not assigned — the server would not |
| `vikunja_relate_tasks` | write | relate two tasks by key under one of Vikunja's 11 kinds; the server writes the inverse |
| `vikunja_unrelate_tasks` | write | remove one relation of a named kind; the server drops both directions |
| `vikunja_delete_task` | write | isolated so it can be denied on its own |
| `vikunja_delete_comment` | write | same isolation as `delete_task`, for one comment |
| `vikunja_delete_label` | write | deletes the label itself; refuses while tasks carry it unless `force`, and reports how many lost it |

Comments are the one thing here **not** addressed by key: they have no per-task sequence, so
get/update/delete take the task (key or `{ id }`) plus the comment's global `commentId`. Both
travel in the URL because the server matches them — a comment id belonging to another task is a
404, not a silent read. Editing and deleting are **author-only** on the server (see the REST
notes); both tools say so, because the 403 is otherwise unexplainable from the agent's side.

The comment tools' shared body — `resolveCommentTarget` and `applyCommentUpdate` — lives in
`tools/task-target.ts`, not in the four tool files, and that placement is deliberate: the shared
body is the substance worth proving, so it lives in one module a test drives directly rather than
being restated in each tool file. What stays in a tool file is the schema, the annotations and the
one call. `vikunja_bulk_update_tasks` follows the same rule for the
same reason — `resolveBulkTargets`, `findBulkBlockers` and `applyBulkUpdate` are all in that
module, because the ordering the tool depends on (resolve, vet, *then* write) is exactly what a
restated test body would leave unproved.

The three label tools follow the same rule through `tools/label-fields.ts`: the shared `label`
and colour argument shapes, the two refusals that need no server at all — an update naming no
field, and the delete guard's decision given a task count and `force` — **and the three tool
bodies themselves**, `applyLabelCreate` / `applyLabelUpdate` / `applyLabelDelete`. Same
constraint, same shape: zod plus type-only imports, with the projection handed in as a parameter
rather than imported, and a test that calls the shipped functions rather than a copy of them.

The bodies belong there for a reason worth stating plainly, because the first cut of this work
put them in the registration files and a green suite said nothing: the duplicate-title check, the
delete guard and the rename-side title check could each be deleted with all 379 tests still
passing — nothing exercised the tool files that held them. Since VMCP-31 a tool file *can* be
loaded under `node --test` (see "Checks"), and `test/tools.test.ts` covers the glue each one owns:
its registration, its annotations, and the two guards that live only in a tool file. The logic
worth proving still lives in the shared module and is tested there directly, so a tool file stays a
schema, its annotations and one call.

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
  2.3.0. Several indexes travel in one request too: `index in 24, 25, 26` is legal, whitespace
  included — the parser rewrites `in` to `?=`, and its auto-quoting regex captures everything up
  to `&`, `|` or a paren, so the comma-separated list survives as one quoted value that
  `getNativeValueForTaskField` splits and `getValueForField` trims. Probed live, with and without
  spaces; `resolver.resolveTasks` uses it to resolve a whole key set at one request per project.
  Still match `index` on the result instead of taking row 0 — a build that ignored the
  term would answer with the whole project, and row 0 of that is a different task, which a
  *batched* read makes cheaper to get wrong rather than harder: zipping the answer against the
  requested keys by position mis-assigns every one of them. Cache the
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
  `resolveTask` says so instead of claiming the index does not exist. A write to a task in an
  archived project is refused by the server with **HTTP 412 / code 3008** (`ErrProjectIsArchived`):
  a task-label bulk write, an assignee add, a comment update, a comment delete and a task bulk
  update all earn it — the per-endpoint mechanics are in the bulk, assignee and comment bullets
  below (`:294`, `:417`, `:491`), not restated here. The one known task write that goes through is
  the kanban bucket move: probed on 2.3.0 with a throwaway archived project,
  `POST /projects/{id}/views/{view}/buckets/{bucket}/tasks` moved a task To-Do -> Done and flipped
  its `done` while the project was archived. The discriminator is the project object the permission
  check hands to `Project.CanUpdate`, not the method it calls: `canDoBucket` passes a stub
  `&Project{ID: pv.ProjectID}` whose `IsArchived` is the zero value, so the un-archive exemption
  inside `CanUpdate` swallows the refusal, while the assignee path loads the real archived row and
  keeps it. Task reads are legitimate. This is why the archived refusals in `resolver` live only on
  the *listing* paths: the point is never to be stricter than the server, it is that `GET /tasks`
  answers `[]` — indistinguishable from "this project has no tasks" — and that silent lie is what
  has to be refused. Where the server answers honestly, whether by doing the write or by erroring,
  we pass it through.
- Updating a project writes a fixed column set, so an update that omits `identifier` **erases
  it** — observed live: archiving through a client that PATCHes only `is_archived` left the
  project with `identifier: ""`, silently destroying every task key in it. Whether an archived
  project's *own* update is refused depends on the request payload, not on a standing archive flag:
  `UpdateProject` never calls `CheckIsArchived`, so the only refusal is `CanUpdate`'s, and its
  un-archive exemption passes any payload whose `is_archived` is not `true`. A payload carrying
  `is_archived: true` is refused (412 / code 3008); one that omits it is accepted and un-archives
  the project — which is exactly how un-archiving works, and why the repair for the erased
  identifier is unarchive -> set identifier -> archive.
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
- **`POST /tasks/bulk` is the one genuine partial write, and its `fields` list is load-bearing.**
  Body is `{ task_ids, fields, values }`. With a non-empty `fields`, `updateSingleTask` restores
  every column the list does not name from the stored row — probed on 2.3.0: `fields: ["done"]`
  left description and priority untouched. With an **empty** one it does not: the restore is
  guarded by `if len(fields) > 0`, so `colsToUpdate` stays the full 14 and the "Mergo does ignore
  nil values" block re-zeroes everything the payload omits. Probed: `{ task_ids: [659], fields:
  [], values: { done: true } }` answered **HTTP 200** and left the task with `description: ""`,
  `priority: 0` and a zeroed due date; only the title survived (mergo keeps a non-empty stored
  value). A field listed but absent from `values` writes its zero value, which is exactly how
  `priority: 0` and a cleared due date have to be sent — and exactly why the list must be the
  patch's own keys, never widened. `client.bulkUpdateTasks` refuses an empty list before it builds
  a request.
- **It is one transaction.** `UpdateWeb` opens `db.NewSession()` and rolls back on any error, so
  the set all moves or none of it does. `BulkTask.CanUpdate` only requires that *at least one* id
  exists (400, code 4004 when none do — probed with an empty `task_ids`), and `updateSingleTask`
  then raises `ErrTaskDoesNotExist` (404, code 4002) for a missing one inside the transaction:
  probed with `task_ids: [659, 999999]`, and 659's priority was unchanged afterwards. So never
  pre-filter the ids to "the ones that still exist" — that turns an all-or-nothing call into a
  partial write.
- **Three things ignore `fields` entirely, and the endpoint destroys all three.** In `tasks.go`
  and `task_assignees.go` at v2.3.0, all before or outside the `fields` block:
  `updateTaskAssignees` deletes every assignee when the payload carries none, `updateReminders`
  unconditionally deletes the reminders and re-inserts whatever `values` held (nothing), and
  `if !t.IsFavorite && wasFavorite` drops the task out of the caller's favourites. Probed: a task
  with one assignee, one reminder and `is_favorite: true`, bulk-updated on `priority` alone, came
  back with none of the three. `POST /tasks/{id}` behaves the same way and is saved only by
  echoing the whole stored task back, which a bulk call cannot do — one `values` object serves the
  whole set. Hence the refusal in `findBulkBlockers` rather than a silent strip. `is_favorite` is
  per-user (`wasFavorite` is computed for the calling token's user); reminders and assignees are
  task-global and are destroyed for everyone. All three are populated by `addMoreInfoToTasks`,
  which both read paths go through, and by no write response — so the check runs on rows from a
  read and treats an absent field as blocking, or it fails open on exactly the path it covers.
- **A completion does not stick on a repeating task, and the `fields` list is why.** The server
  computes the roll-forward and returns the new dates in the 200 body, then persists only the
  columns `fields` names — so the roll is discarded. Probed on 2.3.0 against a task with
  `repeat_after: 86400`: the body carried `due_date: 2026-07-29`, the stored row still had
  `2026-07-20`, `done` stayed `false`, and `done_at` was stamped anyway. The task is left open,
  overdue and marked as completed at the same time. `POST /tasks/{id}` rolls it correctly, so this
  is the bulk path alone; a single-task control on an identical task moved due, start and end.
  Hence the fourth, *conditional* refusal in `findBulkBlockers` — and the condition is the
  **transition**, not the field. `updateDone` enters its repeat branch on `!oldTask.Done &&
  newTask.Done` alone, so only a `done: true` on a task that is not already done can be
  mishandled. A bulk `done: false` on a repeating task is honest — probed on 2.3.0: nothing moved,
  no `done_at` was stamped — and re-asserting a `done` it already carries is no transition either.
  Refusing those would be stricter than the server, and would point the caller at
  `vikunja_complete_task`, which only ever writes `done: true`.
  **Detecting one needs both fields.** `repeat_mode` is `0` (by the `repeat_after` interval), `1`
  (monthly, *ignoring* `repeat_after`) or `2` (from today, by the interval). Take those from
  `models.TaskRepeatMode` in the server's `docs.json` — `enum: [0, 1, 2]`, `x-enum-varnames:
  [Default, Month, FromCurrentDate]` — and **not** from the prose `description` of `repeat_mode`
  in the same file, which says "3 = repeats from the current date": that is Vikunja's own typo,
  contradicted by the enum three lines away. So a monthly-repeating task is
  `{ repeat_mode: 1, repeat_after: 0 }` and a check on the interval alone calls it non-repeating.
  Both fields are plain columns rather than anything `addMoreInfoToTasks` enriches, so both read
  paths always send them, as zero values when the task does not repeat — probed on both paths.
- **The 200 body is not the answer**, like every other write here: the handler renders the whole
  `BulkTask` struct back — `task_ids`, `fields`, `values` and a `tasks` array whose rows never went
  through `setIdentifier`. Probed: every row came back with `identifier: ""` and `labels: null`.
  Read the tasks back instead — and note the repeating case above is what makes that more than
  hygiene: echoing the body would have reported a due date that is not in the database.
- Two more bulk facts worth not re-deriving. `done_at` is **not** writable — naming it answers 400
  with code 4027 (`ErrInvalidTaskColumn`); `updateDone` appends it itself when `done` changes, and
  the done-bucket move is the server's too. And `values` needs no title: `UpdateWeb` validates the
  bound struct through govalidator and `Task.Title` carries `minstringlength(1)`, but an empty
  value is skipped rather than required — probed, `values: { done: true }` answered 200 and left
  every title alone. Nothing at 2.3.0 raises `ErrBulkTasksMustBeInSameProject` (code 4003) either:
  `CanUpdate` collects the distinct projects and checks `CanWrite` on each, so a cross-project
  call is one request and is accepted.
- **An archived project needs no refusal of ours on the bulk path — but only because the `ids`
  escape hatch is not batched.** A key in one is already unresolvable (`GET /tasks` omits archived
  projects, and `resolveTasks` says so). An id read through `GET /tasks/{id}` resolves fine, and
  the write is then refused by the server: `BulkTask.CanUpdate` calls `Project.CanWrite`, which
  returns `ErrProjectIsArchived` (412, code 3008) — probed on 2.3.0 against a throwaway archived
  project, and the refusal came through verbatim with no task in the call changed — and the
  transaction takes the whole call with it, which is the answer we want. Batch those ids through
  `filter=id in …` instead and it breaks silently: the collection answers `[]`, and a task that
  exists is reported missing. That is why `resolveBulkTargets` spends one request per id.
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
- **The label entity itself takes anything.** `PUT /labels` answers 201 for `title: ""` — the
  `runelength(1|250)` tag skips an empty string, and a whitespace-only title is stored verbatim —
  and 201 again for a title another label already holds (two `vmcp23-probe-a` labels created back
  to back, both accepted). The case-sensitive uniqueness check in these notes is about *project
  identifiers*; nothing enforces label-title uniqueness at all. Both refusals are therefore ours,
  and the duplicate one is not cosmetic: `resolveLabelIds` refuses an ambiguous title, so a second
  `bug` makes **both** unaddressable by title in `create_task`, `label_task` and
  `set_task_labels` at once. The empty-title refusal belongs on the update path as well as the
  create one — `POST /labels/{id}` accepts `""` just as happily.
- **`POST /labels/{id}` is a fixed-column write, exactly like the task update.** `Label.Update`
  writes `Cols("title", "description", "hex_color")`, so an omitted field is zeroed rather than
  kept. Probed on 2.3.0: a label with a description and `hex_color: e8e8e8`, updated with
  `{ title }` alone, came back with both blanked; updated with `{ hex_color }` alone, its title
  became `""`. `client.updateLabel` therefore merges the patch onto the whole stored record — but,
  unlike `client.updateTask`, it does **not** read that record itself: the resolver already
  listed every label to find this one, so the record arrives from the caller and the merge is
  complete by type rather than by a second request.
- **`hex_color` is validated as `runelength(0|7)` and then normalized, and the normalization is
  where data is lost.** `NormalizeHex` (v2.3.0 `pkg/utils`) strips a leading `#` *and truncates to
  six characters*: `#ff0000` stores `ff0000` (fine) and `ff00001` — 7 runes, so it passes the
  length check — stores `ff0000` too, silently. `not-a-color` is refused with 412 code 2002, but
  `red` passes the length check and is stored as a colour nothing can render. Both gaps are why
  `projection.parseHexColor` demands six hex digits here rather than leaning on the server. Stored
  values are mostly upper-case in practice (34 of one instance's 39 labels), so `toLeanLabel`
  reports a canonical lower-case form without the `#`.
- **Deleting a label detaches it from every task, with no warning and no undo.** Verified live: a
  task carrying the label reported `labels: null` immediately after `DELETE /labels/{id}`, and the
  delete itself answered a plain 200. Mechanically the `label_tasks` rows are *not* removed —
  `Label.Delete` is a single `s.ID(l.ID).Delete(&Label{})` — the task simply stops reporting a
  label the read can no longer join. So word it `detachedFrom` for the caller and do not promise
  cleanup. This is the whole reason `vikunja_delete_label` counts first and refuses without
  `force`; renaming needs no such guard, since a board's filter buckets key on label *ids*
  (`labels in 45`) and survive a rename.
- **That count is a floor, and the cheap-looking shortcut is a trap.** It goes through
  `listTasks({ labelId })` (`labels in <id>`), which exhausts pagination and parses every matching
  row — 142 for `feature` on this instance — and it misses tasks in archived projects, since
  `GET /tasks` builds its collection from non-archived ones and takes no parameter to widen that.
  The refusal says so rather than claiming a total. `x-pagination-result-count` is **not** the
  count: it reports the rows in the page just returned. Probed on `labels in 5`: `per_page=1`
  answers `result-count: 1` and `total-pages: 142`, `per_page=1000` answers `result-count: 142`
  and `total-pages: 1` — so a guard built on the result count would refuse "1 task" for a label on
  142.
- **Updating and deleting a label are owner-only, and that is the server's call to make.**
  `Label.CanUpdate` and `CanDelete` (v2.3.0 `label_permissions.go`) both go through `isLabelOwner`
  (`CreatedByID == a.GetID()`), while `CanRead` also passes anyone who can see a task the label is
  on — so the listing can show a label these tools cannot change, and the server answers 403. Do
  not pre-check ownership: `created_by` would have to cross into a layer that has no business with
  it, and the check would be a second source of truth for a rule the server already enforces. Both
  write tools say so in their descriptions instead.
- A label id that no longer exists reads as **403**, not 404: `GET /labels/{id}` on a deleted
  label answered "You don't have the permission to see this" with no Vikunja code, while
  `POST`/`DELETE` on an id that never existed answered 404 code 8002. Neither is worth branching
  on — but no error message here may promise a 404 for a missing label.
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
- **A multi-user assign is not atomic, and must say so.** There is no bulk endpoint (the one that
  exists replaces the whole list and is not exposed), and a user id is deliberately never gated
  locally, so a 7003 is knowable only from the response — by which time earlier users in the same
  call are assigned and stay assigned. `client.addTaskAssignees` therefore names what landed in
  the error it throws, keeping the server's message verbatim and the original error on `cause`. A
  failure on the *first* write is passed through untouched: nothing landed, so a
  partial-application note there would be false. Resolution still precedes every write, so an
  unresolvable *name* changes nothing at all — the two guarantees are different and only one of
  them is atomicity.
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
- **Relations are one write, both directions.** `PUT /tasks/{id}/relations` with
  `{ other_task_id, relation_kind }` inserts `(t, o, kind)` *and* `(o, t, inverse(kind))` in the
  same call (`task_relation.go`), so never issue a second write for the inverse — it would earn
  the "relation already exists" refusal (code 4008). `DELETE
  /tasks/{id}/relations/{kind}/{other}` likewise removes both rows. The kind and the other task
  travel in the DELETE path; the PUT body is snake_case.
- **Relation error codes, read off `error.go` at v2.3.0** — check them there before branching on
  one, because the 400x range is shared with task errors that have nothing to do with relations,
  and an off-by-a-few code silently names a different failure: `4007`
  `ErrCodeInvalidRelationKind`, `4008` `ErrCodeRelationAlreadyExists`, `4009`
  `ErrCodeRelationDoesNotExist` (what unrelating a relation that is not there produces), `4010`
  `ErrCodeRelationTasksCannotBeTheSame`, `4023` `ErrCodeTaskRelationCycle`. For contrast, the
  neighbours a plausible guess lands on: `4001` is `ErrCodeTaskCannotBeEmpty`, `4004`
  `ErrCodeBulkTasksNeedAtLeastOne`, `4005` `ErrCodeNoRightToSeeTask`.
- The kind vocabulary is 11 strings — `subtask`/`parenttask`, `blocking`/`blocked`,
  `precedes`/`follows`, `duplicateof`/`duplicates`, `copiedfrom`/`copiedto`, `related` — paired
  as their own inverses. `unknown` exists as a Go constant but `RelationKind.isValid()` rejects
  it, so it is not offered. Direction is the named task's: `relate(A, blocking, B)` records that
  A blocks B.
- **The relation checks live in the permission layer, not in `Create`.** `TaskRelation.CanCreate`
  (`task_relation_permissions.go`) is what rejects an unknown kind and what loads the other task
  and requires `CanRead` on it — note read, not write. `Create` itself does neither, so reading
  only `Create` misleads. We still validate the kind client-side and resolve both keys to ids
  first: a specific error beats a 400, and it costs no round trip.
- **Embedded related tasks have an empty `identifier`.** `setIdentifier` runs on the task being
  read and never on the rows inside `related_tasks` (`otherTask` is `copier.Copy`'d), so a
  related task's key must be rebuilt from its `index` plus *its own* project's identifier — it
  may live in another project, archived included. The identifier for that comes from
  `resolver.taskRefLookup`, which answers out of the `GET /projects` index and therefore knows
  archived projects too: the archive blindness of `GET /tasks` constrains which *named* task can
  be resolved by key, not which project a related task's key can be built from.
- **Both read paths embed relations**, so the key path is not the poor relation of the id one.
  `GET /tasks/{id}` populates `related_tasks`, and so does the `GET /tasks` collection that
  `resolver.resolveTask` resolves a key through (`ReadAll` -> `getTasksForProjects` ->
  `addMoreInfoToTasks` -> `addRelatedTasksToTasks`; `tasks.go` initializes the map, so a
  collection row carries at least `{}`).
- `related_tasks` empty comes in three shapes: absent, `null` (a nil Go map) and `{}`. It is also
  `xorm:"-"`, hence ignored on writes — which is why the read-modify-write in `client.updateTask`
  can spread it into the update body harmlessly. Relations must never be sent through a task
  write.
- Comment update is the **opposite** of the task one, so do not generalize from it. `POST
  /tasks/{task}/comments/{comment}` is Update in the same uniform CRUD handler, but its body is
  `s.ID(...).Cols("comment").Update(tc)` (`pkg/models/task_comments.go` at v2.3.0): a single
  column, no re-zeroing, so `{ comment }` alone is a correct partial write and needs no
  read-modify-write. `author`, `created` and `updated` are server-managed and never sent.
- A comment's address is `task + commentId`, and both halves are checked: `getTaskCommentSimple`
  ANDs `task_id` into the lookup (an explicit IDOR guard), so a comment id belonging to another
  task answers 404 with code **4015** (`ErrCodeTaskCommentDoesNotExist`, read out of
  `pkg/models/error.go`) — the same answer an id that exists nowhere gets.
- A comment's `author` is the **full user object** (`pkg/user/user.go`: `id`, `name`, `username`,
  `email`, timestamps), and the listing also carries `reactions` and `updated`. `LeanComment`
  keeps the username and nothing else. On the listing path the author is a map lookup by id, so
  it can be `null` when the user is gone; the single-comment read always fills it in.
- Comment bodies are stored exactly like descriptions: verbatim, unsanitized, and legacy ones may
  be raw markdown. Same conversion on the way in, same allowlist sniff on the way out.
- **Editing and deleting a comment are author-only, and project write access is not enough.**
  `pkg/models/task_comment_permissions.go` at 2.3.0: `CanUpdate` and `CanDelete` both call
  `canUserModifyTaskComment`, which checks `Task.CanWrite` *and then* ends in
  `a.GetID() == savedComment.AuthorID` (a link share is compared against its own user id the same
  way). A project admin editing someone else's comment gets `403 Forbidden` — from
  `echo.NewHTTPError` in the web handler, so the body carries no Vikunja `code`, and
  `VikunjaHttpError.code` is `undefined` rather than a number worth branching on. Creating and
  reading are not restricted this way: `CanCreate` is plain task write access, `CanRead` plain
  task read. Both write tools say so in their descriptions — an agent asked to fix a typo in
  someone else's comment has to be able to anticipate that 403 rather than read it as a broken
  server.
- **Comments on an archived project need no special handling** — the rare case where this server
  can just pass the server through. Writes are refused honestly: `canUserModifyTaskComment` ->
  `Task.CanWrite` -> `canDoTask` -> `Project.CanWrite`, which returns `CheckIsArchived`'s
  `ErrProjectIsArchived` (HTTP 412, code 3008). That is the opposite of the kanban bucket-move
  endpoint, which sails straight through on an archived board. Reads work, and — the part that
  matters — the comment endpoints address the task **by id in the URL**, so they never touch the
  `GET /tasks` collection that answers `[]` for an archived project. The lie the resolver refuses
  on the listing paths cannot occur here, so nothing here refuses anything.

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
them. They run through `node --test` on the TypeScript directly, so **development needs Node 22.18+**
(the `devEngines.runtime` floor), a touch newer than the shipped code's `engines` floor of 22. `tsc` **does**
typecheck `test/`: `npm run typecheck` runs `tsconfig.check.json`, whose `include` is
`["src", "test"]` — only the emitting `tsconfig.json` is scoped to `src`. Biome lints it too. So
widening a `Raw*` type breaks every fixture that builds one, and that is a red build to fix with
the change, not a nit to leave behind.

Every relative import under `src/` names the `.ts` file it points at, not a `.js` one — and
`tsconfig.json` sets `rewriteRelativeImportExtensions` with `allowImportingTsExtensions`, so `tsc`
still emits `.js` specifiers into `dist/` while the source carries `.ts`. That is what lets
`node --test` load a `src` module directly: the type-stripping loader resolves the literal
specifier, and a `.ts` one names a file that exists where the old `.js` one named nothing (the
loader does not rewrite `.js` to `.ts`). So `src/tools/*` is as loadable as any other module —
`test/tools.test.ts` loads `src/register-tools.ts` and every tool file it pulls in — and a shared
runtime constant may live wherever it belongs rather than being routed into `types.ts` to dodge a
value import. Only **relative** specifiers carry `.ts`: bare package specifiers ending in `.js`
(`@modelcontextprotocol/sdk/server/mcp.js`) are left exactly as they are. The emitted
`dist/**/*.d.ts` keep their `.ts` specifiers — `rewriteRelativeImportExtensions` rewrites the JS
emit only — which is harmless while `package.json` exports no types.

`projection.ts` is pure, so its edge cases are cheap to pin. Anything learned about the live
server's actual shapes belongs in `test/projection.test.ts` as a case, not in a commit message.
