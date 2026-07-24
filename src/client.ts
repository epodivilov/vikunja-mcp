/**
 * REST access to Vikunja. This module is the only place that performs network I/O,
 * which is what makes the "one host" rule enforceable: every request is built from
 * `config.baseUrl`.
 *
 * It stays low level on purpose — it speaks raw API shapes and raw filter strings.
 * Keys, lean DTOs and markdown belong to the layers above.
 */
import type { Config } from "./config.js";
import type {
  RawBucket,
  RawComment,
  RawLabel,
  RawProject,
  RawTask,
  RawUser,
  RawView,
  RelationKind,
  TaskWrite,
} from "./types.js";

/**
 * An upper bound we ask for, not the page size we get. The server clamps `per_page` to its
 * own `service.maxitemsperpage` (50 by default) without erroring, and derives
 * `x-pagination-total-pages` from the clamped value — so asking for the ceiling yields the
 * largest page a given instance allows, and pagination still has to be followed.
 */
const PAGE_SIZE = 1000;

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A ceiling on the paging loop. `x-pagination-total-pages` is server-supplied and nothing
 * validates it, so a buggy or hostile value would turn one tool call into an unbounded run of
 * sequential requests with an array growing until the process dies. At the page sizes we ask
 * for this is far past any real collection.
 */
const MAX_PAGES = 500;

const REDIRECT_REFUSAL =
  "Not followed: this server talks to VIKUNJA_URL and to nothing else. " +
  "Point VIKUNJA_URL at the API root the instance actually serves.";

type QueryValue = string | number | boolean | undefined;
type Query = Record<string, QueryValue>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
}

interface Response_<T> {
  data: T;
  headers: Headers;
}

export interface TaskQuery {
  /** Restrict to one project, by global id. */
  projectId?: number;
  /** Restrict by completion state. Omitted means both, which is what `GET /tasks` returns. */
  done?: boolean;
  /**
   * Escape hatch for expressions the fields above do not cover, e.g. `priority >= 4`. Written
   * in Vikunja's own filter syntax and therefore the one place a caller has to know it.
   *
   * It is ANDed with the fields above rather than replacing them: dropping either side would
   * silently answer a different question than the one asked. When it is combined it is
   * parenthesized, because `&&` binds tighter than `||` — `project_id = 11 && done = false ||
   * done = true` reads as `(project_id = 11 && done = false) || done = true` and answers with
   * every done task on the instance. Measured on 2.3.0: 356 rows for that expression against
   * 16 for the parenthesized one.
   *
   * **Trusted callers only.** Those parens narrow the common case; they are not a containment
   * boundary. An expression that closes them itself — `done = false) || (done = true` — merges
   * into a perfectly balanced string that widened the same live query from 16 rows to 357
   * across six projects. Containing that would take a parser for a filter dialect we do not
   * own, and it buys nothing today: no tool exposes this field, and the only caller inside the
   * process writes the expression itself. A tool that ever does expose it has to solve
   * containment first — this field must not be wired to model-supplied text as it stands.
   */
  filter?: string;
  /** Free-text search (`s` in the API). */
  search?: string;
  sortBy?: string;
  orderBy?: "asc" | "desc";
}

/**
 * A non-2xx answer from Vikunja. The status and Vikunja's own `code` are carried as fields, not
 * only baked into the message, so the layers above can branch on an outcome: 404 is "no such
 * task" and tells the resolver its cached project map is stale, 401 is "check the token". The
 * alternative is every caller matching on message text, which would make the wording of that
 * message load-bearing.
 */
export class VikunjaHttpError extends Error {
  readonly status: number;
  readonly code: number | undefined;

  constructor(message: string, status: number, code?: number) {
    super(message);
    this.name = "VikunjaHttpError";
    this.status = status;
    this.code = code;
  }
}

export interface ClientOptions {
  /** Items per request. Lower values exist to exercise pagination; production uses the default. */
  pageSize?: number;
  /**
   * The `fetch` every request goes through. Defaults to `globalThis.fetch`; injecting a stub is
   * how the transport is tested without a live server. Only the seam — the "one host" rule still
   * holds, since the URL is always built from `config.baseUrl`.
   */
  fetch?: typeof globalThis.fetch;
}

export class VikunjaClient {
  readonly #config: Config;
  readonly #pageSize: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(config: Config, options: ClientOptions = {}) {
    this.#config = config;
    this.#pageSize = options.pageSize ?? PAGE_SIZE;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  // --- projects ---------------------------------------------------------------

  /**
   * Archived projects included. Without `is_archived` the server appends
   * `HAVING MAX(all_projects.is_archived) = 0` and drops them — along with anything under an
   * archived parent, since a child inherits the flag. The resolver builds its key map from this
   * call, so omitting them would answer a perfectly good `OLD-4` with "no project has that key":
   * false, and not fixable from the agent's side. Reads of an archived task are legitimate, and
   * so are some writes: the server refuses an update to the project itself, but lets a kanban
   * bucket-move through (probed on 2.3.0 — it moved a task and flipped its `done` on an archived
   * board). The archive flag is not a write barrier, so nothing here treats it as one.
   */
  listProjects(): Promise<RawProject[]> {
    return this.#requestAll<RawProject>("/projects", { is_archived: true });
  }

  getProject(id: number): Promise<RawProject> {
    return this.#requestObject<RawProject>("GET", `/projects/${id}`);
  }

  /**
   * Everyone Vikunja considers a member of a project: its owner, its direct user shares, the
   * members of every team it is shared with, and everything inherited by walking up the parent
   * chain. This is the candidate set for an assignment.
   *
   * Deliberately called without the `s` search parameter. `s` matches *fuzzily* — ILIKE over name,
   * username and email — so it cannot identify one user, and it is also what makes the server fill
   * in the email field. Listing everyone and matching locally is both correct and less data.
   *
   * The endpoint is not paginated on 2.3.0: the handler answers a plain `c.JSON(200, users)` with
   * no `x-pagination-*` headers, which `#requestAll` reads as a single page. It goes through
   * `#requestAll` anyway, so an instance that ever does paginate it is exhausted rather than
   * silently truncated.
   */
  listProjectUsers(projectId: number): Promise<RawUser[]> {
    return this.#requestAll<RawUser>(`/projects/${projectId}/projectusers`);
  }

  // --- tasks ------------------------------------------------------------------

  /**
   * Lists tasks across projects. Uses `GET /tasks` with a filter rather than the
   * legacy `GET /projects/{id}/tasks`, which is undocumented in v2.3.0, and rather
   * than the per-view endpoint, which silently applies that view's own filter.
   *
   * The filter expression is assembled here, from structured fields, so that the layers above
   * never have to spell `project_id = 11 && done = false` themselves — that string is Vikunja
   * dialect, and this is the layer that owns it.
   */
  listTasks(query: TaskQuery = {}): Promise<RawTask[]> {
    return this.#requestAll<RawTask>("/tasks", {
      filter: buildTaskFilter(query),
      s: query.search,
      sort_by: query.sortBy,
      order_by: query.orderBy,
    });
  }

  getTask(id: number): Promise<RawTask> {
    return this.#requestObject<RawTask>("GET", `/tasks/${id}`);
  }

  /**
   * Creates a task, optionally assigned to `assigneeIds` in the same request.
   *
   * Assignees travel in the create payload where labels cannot: the handler runs
   * `createTask(..., updateAssignees: true)`, writing them inside the task's own transaction,
   * which the web layer rolls back on error. So a rejected assignee leaves no half-created task
   * behind, and a valid one costs no second request.
   *
   * The response is not the created task as stored: it echoes back the very `[{ id }]` objects
   * this body carried, with no usernames on them. Callers read the task back.
   */
  createTask(
    projectId: number,
    task: TaskWrite,
    assigneeIds: readonly number[] = [],
  ): Promise<RawTask> {
    const body =
      assigneeIds.length === 0 ? task : { ...task, assignees: assigneeIds.map((id) => ({ id })) };

    return this.#requestObject<RawTask>("PUT", `/projects/${projectId}/tasks`, { body });
  }

  /**
   * Read-modify-write, despite the name. `POST /tasks/{id}` is NOT a partial update: the
   * handler binds the body onto an empty struct, writes a fixed column set, and explicitly
   * re-zeroes everything the payload omitted — description, priority, due/start/end date,
   * percent_done, hex_color — while assignees and reminders are replaced wholesale. Sending
   * `{ done: true }` on its own would therefore strip the task bare.
   *
   * So the server's own representation is read back and the patch layered onto it. Spreading
   * the raw object is what makes this safe: it still carries the fields `RawTask` does not
   * declare (assignees, reminders, labels), and those are zeroed just the same.
   */
  async updateTask(id: number, task: TaskWrite): Promise<RawTask> {
    const current = await this.getTask(id);
    return this.#requestObject<RawTask>("POST", `/tasks/${id}`, {
      body: { ...current, ...task },
    });
  }

  async deleteTask(id: number): Promise<void> {
    await this.#request<unknown>("DELETE", `/tasks/${id}`);
  }

  // --- relations ----------------------------------------------------------------

  /**
   * Relates `taskId` to `otherTaskId` under `kind`, read from `taskId`'s side: `blocking` files
   * the other task among the ones this task blocks.
   *
   * One request, not two. `Create` (v2.3.0 `task_relation.go`) inserts both `(t, o, kind)` and
   * `(o, t, inverse(kind))` in the same call, so writing the inverse ourselves would only earn
   * the "relation already exists" refusal. Validation lives one layer up in `CanCreate`: it
   * rejects an unknown kind and requires read access to the other task, which is why an invalid
   * relation is refused rather than stored — and why a refusal arrives as a `VikunjaHttpError`
   * carrying Vikunja's own code rather than being swallowed. From `error.go` at v2.3.0: 4008
   * the relation already exists, 4010 the two tasks are the same, 4023 a subtask cycle, 4007 an
   * unknown kind. Read those numbers off the source before branching on one — the 400x range is
   * shared with unrelated task errors, and the neighbouring codes mean nothing like these.
   */
  async createRelation(taskId: number, otherTaskId: number, kind: RelationKind): Promise<void> {
    await this.#request<unknown>("PUT", `/tasks/${taskId}/relations`, {
      body: { other_task_id: otherTaskId, relation_kind: kind },
    });
  }

  /**
   * Removes one relation. The kind and the other task go in the path — this endpoint takes no
   * body — and the server drops the inverse row along with it, so one call clears both
   * directions. A relation that is not there comes back as 4009, not as a silent success.
   * `encodeURIComponent` because a path segment is the one place a string that is not the value
   * it claims to be would be read as structure; callers get the kind from `parseRelationKind`
   * in `types`, and this makes that a belt as well as braces.
   */
  async deleteRelation(taskId: number, kind: RelationKind, otherTaskId: number): Promise<void> {
    await this.#request<unknown>(
      "DELETE",
      `/tasks/${taskId}/relations/${encodeURIComponent(kind)}/${otherTaskId}`,
    );
  }

  // --- labels -----------------------------------------------------------------

  listLabels(): Promise<RawLabel[]> {
    return this.#requestAll<RawLabel>("/labels");
  }

  /**
   * Attaches an existing label to a task. One request per label; the endpoint takes one id.
   *
   * Labels do not travel in the task payload, despite the API accepting one there. Probed on
   * 2.3.0: `PUT /projects/1/tasks` with `labels: [{ id: 2 }]` answered 201 echoing that label,
   * and the read that followed reported `labels: null` — the create handler never writes the
   * link table. The update path does not touch it either, which is what makes labels survive
   * the read-modify-write above. So the association has its own endpoint, and this is it.
   *
   * A label already on the task is refused with code 8001, an unknown one with 8002; both
   * surface as `VikunjaHttpError` rather than being swallowed.
   */
  async addTaskLabel(taskId: number, labelId: number): Promise<void> {
    await this.#request<unknown>("PUT", `/tasks/${taskId}/labels`, { body: { label_id: labelId } });
  }

  /**
   * Reconciles a task's labels to exactly `labelIds`, in one request and one transaction.
   *
   * `UpdateTaskLabels` deletes the labels not passed, adds the ones missing, and does both inside
   * the session `db.NewSession()` opens — so a bad id in the list rolls the deletes back too, and
   * there is no observable intermediate state. That is what makes this the whole of a label
   * change rather than a step in one: adds and removes land together, and re-adding a label the
   * task already has (or removing one it does not) is not an error, because the endpoint
   * reconciles by set membership rather than by operation.
   *
   * An empty list is the documented way to clear every label — there is an explicit branch for
   * it — so it is sent as a request rather than optimised away.
   *
   * The 201 body is not the result: it echoes the label array it was handed, not what the server
   * stored. Callers that need the outcome read the task back.
   */
  async setTaskLabels(taskId: number, labelIds: readonly number[]): Promise<void> {
    await this.#request<unknown>("POST", `/tasks/${taskId}/labels/bulk`, {
      body: { labels: labelIds.map((id) => ({ id })) },
    });
  }

  // --- assignees --------------------------------------------------------------

  /**
   * Assigns one user to a task. One request per user; the endpoint takes one id.
   *
   * Refusals reach the caller as `VikunjaHttpError` rather than being swallowed: 400 / code 4021
   * for a user already assigned (which the resolver's diff avoids reaching), 403 / code 7003 for
   * a user without access to the project, and the archived-project error, since the permission
   * check loads the project from the task and `CanWrite` refuses an archived one.
   */
  async addTaskAssignee(taskId: number, userId: number): Promise<void> {
    await this.#request<unknown>("PUT", `/tasks/${taskId}/assignees`, {
      body: { user_id: userId },
    });
  }

  /**
   * Assigns several users, one request each, and — this is the whole reason the loop lives here
   * rather than in the tool — reports honestly when the run is cut short.
   *
   * There is no bulk endpoint that would make this atomic, and the refusal that stops it cannot be
   * pre-empted: a user id is deliberately never gated against the project's member listing (that
   * listing has a hole, and the access check is the server's), so a 403 arrives only once the
   * request is out. By then earlier assignments have already been written and they stay written.
   *
   * Reporting that as a plain failure would leave the caller with a false picture — an agent would
   * retry the whole call or tell its user nothing changed, while the task carries half of it. So a
   * failure after something landed is rethrown naming exactly what landed, with the server's own
   * message kept verbatim and the original error on `cause` for anyone who wants its status. A
   * failure on the first write is passed through untouched: nothing landed, so there is nothing to
   * add, and a partial-application note there would be its own kind of lie.
   */
  async addTaskAssignees(taskId: number, userIds: readonly number[]): Promise<void> {
    const assigned: number[] = [];

    for (const userId of userIds) {
      try {
        await this.addTaskAssignee(taskId, userId);
      } catch (cause) {
        if (assigned.length === 0) {
          throw cause;
        }

        const landed = assigned.map((id) => `user ${id}`).join(", ");
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `Assigned ${landed} to task ${taskId}, then Vikunja refused user ${userId} — so this call applied only part of what it named, and what it wrote stays written. Read the task to see who is assigned now. The refusal was: ${reason}`,
          { cause },
        );
      }

      assigned.push(userId);
    }
  }

  /**
   * Unassigns one user from a task. The user is named by the path, so there is no body.
   *
   * The server does not check that the assignment existed — the handler is a bare delete — so this
   * answers 200 for a user who was never assigned. Refusing that case is the layer above's job;
   * reporting it as done would be a lie the server is happy to tell.
   */
  async removeTaskAssignee(taskId: number, userId: number): Promise<void> {
    await this.#request<unknown>("DELETE", `/tasks/${taskId}/assignees/${userId}`);
  }

  // --- kanban board -----------------------------------------------------------

  /**
   * A project's views. The board tools read this to find the kanban view and its bucket mode.
   * Few in practice, but routed through `#requestAll` like every other listing so a server that
   * ever paginates it is still exhausted.
   */
  listViews(projectId: number): Promise<RawView[]> {
    return this.#requestAll<RawView>(`/projects/${projectId}/views`);
  }

  /**
   * The kanban board of one view: an array of buckets, each with its tasks embedded, in column
   * order. This is the ONLY source of column membership — `GET /tasks` carries no view context
   * and reports every task in bucket 0.
   *
   * Its pagination is unlike every other endpoint here, so it cannot go through `#requestAll`.
   * `x-pagination-total-pages` is always 1 (it counts buckets, not tasks) and each bucket's own
   * `count` can lag the set actually returned, so neither can end the loop. What `page` really
   * does is slice the tasks *within* every bucket at once. The one server-agnostic signal that a
   * board is exhausted — one that survives an instance clamping `per_page` below what we ask for,
   * which would make a naive "did a bucket return a full page?" check truncate the column — is a
   * page that adds no task to any column. So it walks pages, merging per bucket in first-seen
   * order, until a page contributes nothing.
   */
  async readBoard(projectId: number, viewId: number): Promise<RawBucket[]> {
    const path = `/projects/${projectId}/views/${viewId}/tasks`;
    const order: { id: number; title: string }[] = [];
    const tasksById = new Map<number, RawTask[]>();

    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) {
        throw new Error(
          `Vikunja GET ${path} kept returning tasks past the ${MAX_PAGES} pages this client will walk. A single column is larger than any real board, or the server is ignoring pagination.`,
        );
      }

      const response = await this.#requestPage<RawBucket>(path, {}, page);
      let added = 0;

      for (const bucket of response.data ?? []) {
        let accumulated = tasksById.get(bucket.id);
        if (accumulated === undefined) {
          accumulated = [];
          tasksById.set(bucket.id, accumulated);
          order.push({ id: bucket.id, title: bucket.title });
        }
        const tasks = bucket.tasks ?? [];
        accumulated.push(...tasks);
        added += tasks.length;
      }

      // A page that added nothing to any column means every column is exhausted. On a board that
      // fits one page this costs one extra request; a board read is not a hot path.
      if (added === 0) {
        break;
      }
    }

    return order.map(({ id, title }) => ({ id, title, tasks: tasksById.get(id) ?? [] }));
  }

  /**
   * The buckets of a manual kanban view, for mapping a column name to its id before a move. These
   * are physical rows with `tasks: null`; the board is never read from here — the tasks are not
   * embedded, and a filter view answers with stale rows unrelated to its columns. That is
   * `readBoard`'s job.
   */
  listBuckets(projectId: number, viewId: number): Promise<RawBucket[]> {
    return this.#requestAll<RawBucket>(`/projects/${projectId}/views/${viewId}/buckets`);
  }

  /**
   * Moves a task into a bucket on a manual board. Vikunja writes `task_buckets`, enforces the
   * bucket's WIP limit (erroring when it is full), and flips the task's `done` when it crosses the
   * view's done bucket — all server-side, so the caller reads the task back to see the outcome
   * rather than assuming it.
   */
  async moveTask(
    projectId: number,
    viewId: number,
    bucketId: number,
    taskId: number,
  ): Promise<void> {
    await this.#request<unknown>(
      "POST",
      `/projects/${projectId}/views/${viewId}/buckets/${bucketId}/tasks`,
      { body: { task_id: taskId } },
    );
  }

  // --- comments ---------------------------------------------------------------

  listComments(taskId: number): Promise<RawComment[]> {
    return this.#requestAll<RawComment>(`/tasks/${taskId}/comments`);
  }

  createComment(taskId: number, comment: string): Promise<RawComment> {
    return this.#requestObject<RawComment>("PUT", `/tasks/${taskId}/comments`, {
      body: { comment },
    });
  }

  // --- server info ------------------------------------------------------------

  /**
   * The instance's own `max_items_per_page`, read from `GET /info`, or `undefined` when `/info`
   * cannot be read or does not report a usable value. This is the number the server actually
   * honors as the `per_page` ceiling — it clamps anything larger to it — so discovering it turns
   * the guessed `PAGE_SIZE` into the value the instance publishes.
   *
   * Goes through `#request` so the one-host rule, redirect refusal and error handling stay in one
   * place. `/info` is a bare object, not a paginated collection, so it is not routed through
   * `#requestAll`. The endpoint needs no auth; the `Bearer` header `#request` attaches anyway is
   * harmless.
   *
   * Every failure mode — unreachable, non-2xx, non-JSON, field absent, field not a positive
   * integer — collapses to `undefined` on purpose: discovery must never keep the server from
   * starting. `resolvePageSize` turns that `undefined` into the default plus one diagnostic, so
   * the swallow here is the documented fallback, not a hidden error.
   */
  async fetchMaxItemsPerPage(): Promise<number | undefined> {
    let info: unknown;
    try {
      info = (await this.#request<unknown>("GET", "/info")).data;
    } catch {
      return undefined;
    }

    if (typeof info !== "object" || info === null || !("max_items_per_page" in info)) {
      return undefined;
    }

    const reported = (info as { max_items_per_page: unknown }).max_items_per_page;
    return typeof reported === "number" && Number.isInteger(reported) && reported > 0
      ? reported
      : undefined;
  }

  // --- transport --------------------------------------------------------------

  /**
   * Exhausts a paginated collection. Vikunja reports `x-pagination-total-pages`, and
   * reports 0 for an empty collection — hence "fetch page 1, then walk to the total"
   * rather than a loop over a page count that may be 0.
   */
  async #requestAll<T>(path: string, query: Query = {}): Promise<T[]> {
    const first = await this.#requestPage<T>(path, query, 1);
    const items = first.data ?? [];
    const totalPages = readTotalPages(first.headers);

    if (totalPages > MAX_PAGES) {
      throw new Error(
        `Vikunja GET ${path} reports ${totalPages} pages, past the ${MAX_PAGES} this client will walk. Narrow the request with a filter.`,
      );
    }

    for (let page = 2; page <= totalPages; page++) {
      const next = await this.#requestPage<T>(path, query, page);
      items.push(...(next.data ?? []));
    }

    return items;
  }

  /**
   * For endpoints that owe us an object. `#request` reports an empty body as `null`, and
   * without this the `null` would reach the layers above wearing a non-nullable type, to fail
   * later as "cannot read properties of null" in a module with no idea which call produced it.
   */
  async #requestObject<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.#request<T | null>(method, path, options);

    if (response.data === null) {
      throw new Error(`Vikunja ${method} ${path} returned an empty body where an object was due`);
    }

    return response.data;
  }

  #requestPage<T>(path: string, query: Query, page: number): Promise<Response_<T[] | null>> {
    return this.#request<T[] | null>("GET", path, {
      query: { ...query, page, per_page: this.#pageSize },
    });
  }

  async #request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<Response_<T>> {
    const url = this.#url(path, options.query);

    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.#config.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        // "one host" has to be enforced here rather than assumed: the default is to follow
        // redirects, which would let the configured server hand our traffic to another origin.
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // Reading the body belongs inside the try. `fetch` settles as soon as headers arrive,
      // so a stalled or reset connection — and the timeout above — fails here, not there.
      text = await response.text();
    } catch (cause) {
      throw new Error(`Vikunja ${method} ${path} failed: ${describeCause(cause)}`, { cause });
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "no Location header";
      throw new VikunjaHttpError(
        `Vikunja ${method} ${path} -> HTTP ${response.status} redirecting to ${location}. ${REDIRECT_REFUSAL}`,
        response.status,
      );
    }

    if (!response.ok) {
      throw httpError(method, path, response.status, text);
    }

    if (text === "") {
      return { data: null as T, headers: response.headers };
    }

    try {
      return { data: JSON.parse(text) as T, headers: response.headers };
    } catch {
      const hint = "check that VIKUNJA_URL points at the API root, which usually ends in /api/v1";
      throw new Error(
        `Vikunja ${method} ${path} returned a non-JSON body (${hint}): ${truncate(text)}`,
      );
    }
  }

  #url(path: string, query: Query = {}): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        search.set(key, String(value));
      }
    }
    const queryString = search.toString();
    return `${this.#config.baseUrl}${path}${queryString === "" ? "" : `?${queryString}`}`;
  }
}

export interface ResolvePageSizeOptions {
  /** The `fetch` discovery goes through. Defaults to `globalThis.fetch`; tests inject a stub. */
  fetch?: typeof globalThis.fetch;
  /**
   * Sink for the single diagnostic emitted when discovery falls back to the default. `index.ts`
   * wires it to stderr; keeping it injectable is what lets the network layer stay free of any
   * `process` coupling. Called at most once, and only on the fallback path.
   */
  warn?: (message: string) => void;
}

/**
 * The page size to send on every paginated request, discovered from the instance rather than
 * guessed. Reads `max_items_per_page` from `GET /info` once, at startup, and returns it; when
 * `/info` cannot be read or does not report a usable value, returns the default `PAGE_SIZE` and
 * signals the fallback through `options.warn`.
 *
 * This is the startup seam, and the only path that discovers. The plain `new VikunjaClient(config)`
 * constructor never touches `/info`, so the pagination escape hatch — `new VikunjaClient(config,
 * { pageSize })` — keeps its explicit value and issues no `/info` request.
 */
export async function resolvePageSize(
  config: Config,
  options: ResolvePageSizeOptions = {},
): Promise<number> {
  const probe = new VikunjaClient(config, { fetch: options.fetch });
  const discovered = await probe.fetchMaxItemsPerPage();
  if (discovered !== undefined) {
    return discovered;
  }

  options.warn?.(
    `Could not read a usable max_items_per_page from ${config.baseUrl}/info; ` +
      `falling back to the default page size of ${PAGE_SIZE}.`,
  );
  return PAGE_SIZE;
}

/**
 * A `TaskQuery` as one Vikunja filter expression, or undefined when it constrains nothing.
 *
 * Terms are joined with `&&` in a fixed order so the same query always produces the same string.
 * The caller-supplied expression goes last and parenthesized — see `TaskQuery.filter` for why
 * that paren is load-bearing rather than decorative. A lone expression is passed through
 * untouched, so a caller that wants exactly what it wrote still gets exactly what it wrote.
 */
function buildTaskFilter(query: TaskQuery): string | undefined {
  const terms: string[] = [];

  // Both structured values are interpolated into a filter expression, so both are checked
  // rather than trusted. A static type is a compile-time promise, and these arrive over MCP as
  // JSON that was parsed, not proved; anything that is not the value it claims to be would
  // travel to the server as syntax and come back as a parse error naming a field the caller
  // never mentioned.
  if (query.projectId !== undefined) {
    if (!Number.isSafeInteger(query.projectId) || query.projectId <= 0) {
      throw new Error(`Project id must be a positive integer, got ${query.projectId}.`);
    }
    terms.push(`project_id = ${query.projectId}`);
  }

  if (query.done !== undefined) {
    if (typeof query.done !== "boolean") {
      throw new Error(`The done filter must be true or false, got ${JSON.stringify(query.done)}.`);
    }
    terms.push(`done = ${query.done}`);
  }

  const filter = query.filter?.trim();
  if (filter !== undefined && filter !== "") {
    terms.push(terms.length === 0 ? filter : `(${filter})`);
  }

  return terms.length === 0 ? undefined : terms.join(" && ");
}

/** Missing header means we cannot know of more pages — treat the page in hand as all of it. */
function readTotalPages(headers: Headers): number {
  const raw = headers.get("x-pagination-total-pages");
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 1;
}

/** Vikunja errors are `{ code, message }`; anything else is surfaced as-is rather than swallowed. */
function httpError(method: string, path: string, status: number, body: string): VikunjaHttpError {
  let detail = body.trim();
  let code: number | undefined;

  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
      const fields = parsed as { message: unknown; code?: unknown };
      if (typeof fields.code === "number") {
        code = fields.code;
      }
      // An empty `message` is worse than useless as the detail — keep the raw body instead.
      if (typeof fields.message === "string" && fields.message !== "") {
        detail = code === undefined ? fields.message : `${fields.message} (code ${code})`;
      }
    }
  } catch {
    // Not JSON — keep the raw body.
  }

  const rendered = detail === "" ? "<empty body>" : truncate(detail);
  return new VikunjaHttpError(
    `Vikunja ${method} ${path} -> HTTP ${status}: ${rendered}`,
    status,
    code,
  );
}

function describeCause(cause: unknown): string {
  if (!(cause instanceof Error)) {
    return String(cause);
  }
  if (cause.name === "TimeoutError") {
    return `no response within ${REQUEST_TIMEOUT_MS} ms`;
  }
  const reason = findReason(cause);
  return reason === undefined ? cause.message : `${cause.message} (${reason})`;
}

/**
 * undici reports every connect, DNS and TLS failure as the same "fetch failed" and puts the
 * real reason on `.cause`. Without unwrapping it, a Vikunja that is not running and a typo in
 * VIKUNJA_URL produce identical messages.
 */
function findReason(error: Error): string | undefined {
  let current: unknown = error.cause;

  for (let depth = 0; depth < 5; depth++) {
    if (!(current instanceof Error)) {
      return undefined;
    }
    const code: unknown = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    if (current.message !== "") {
      return current.message;
    }
    current = current.cause;
  }

  return undefined;
}

function truncate(text: string, limit = 500): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
