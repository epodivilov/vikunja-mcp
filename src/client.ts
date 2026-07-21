/**
 * REST access to Vikunja. This module is the only place that performs network I/O,
 * which is what makes the "one host" rule enforceable: every request is built from
 * `config.baseUrl`.
 *
 * It stays low level on purpose — it speaks raw API shapes and raw filter strings.
 * Keys, lean DTOs and markdown belong to the layers above.
 */
import type { Config } from "./config.js";
import type { RawComment, RawLabel, RawProject, RawTask, TaskWrite } from "./types.js";

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
  /** Vikunja filter expression, e.g. `project_id = 11 && done = false`. Passed through verbatim. */
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
}

export class VikunjaClient {
  readonly #config: Config;
  readonly #pageSize: number;

  constructor(config: Config, options: ClientOptions = {}) {
    this.#config = config;
    this.#pageSize = options.pageSize ?? PAGE_SIZE;
  }

  // --- projects ---------------------------------------------------------------

  listProjects(): Promise<RawProject[]> {
    return this.#requestAll<RawProject>("/projects");
  }

  getProject(id: number): Promise<RawProject> {
    return this.#requestObject<RawProject>("GET", `/projects/${id}`);
  }

  // --- tasks ------------------------------------------------------------------

  /**
   * Lists tasks across projects. Uses `GET /tasks` with a filter rather than the
   * legacy `GET /projects/{id}/tasks`, which is undocumented in v2.3.0, and rather
   * than the per-view endpoint, which silently applies that view's own filter.
   */
  listTasks(query: TaskQuery = {}): Promise<RawTask[]> {
    return this.#requestAll<RawTask>("/tasks", {
      filter: query.filter,
      s: query.search,
      sort_by: query.sortBy,
      order_by: query.orderBy,
    });
  }

  getTask(id: number): Promise<RawTask> {
    return this.#requestObject<RawTask>("GET", `/tasks/${id}`);
  }

  createTask(projectId: number, task: TaskWrite): Promise<RawTask> {
    return this.#requestObject<RawTask>("PUT", `/projects/${projectId}/tasks`, { body: task });
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

  // --- labels -----------------------------------------------------------------

  listLabels(): Promise<RawLabel[]> {
    return this.#requestAll<RawLabel>("/labels");
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
      response = await fetch(url, {
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
