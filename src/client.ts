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
 * Vikunja's `max_items_per_page` (1000 by default). Larger values are not rejected —
 * the server silently clamps them — so asking for "everything" in one request is not
 * an option and pagination has to be followed.
 */
const PAGE_SIZE = 1000;

const REQUEST_TIMEOUT_MS = 30_000;

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

  async getProject(id: number): Promise<RawProject> {
    const response = await this.#request<RawProject>("GET", `/projects/${id}`);
    return response.data;
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

  async getTask(id: number): Promise<RawTask> {
    const response = await this.#request<RawTask>("GET", `/tasks/${id}`);
    return response.data;
  }

  async createTask(projectId: number, task: TaskWrite): Promise<RawTask> {
    const response = await this.#request<RawTask>("PUT", `/projects/${projectId}/tasks`, {
      body: task,
    });
    return response.data;
  }

  /** Partial update — only the fields present in `task` are sent. */
  async updateTask(id: number, task: TaskWrite): Promise<RawTask> {
    const response = await this.#request<RawTask>("POST", `/tasks/${id}`, { body: task });
    return response.data;
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

  async createComment(taskId: number, comment: string): Promise<RawComment> {
    const response = await this.#request<RawComment>("PUT", `/tasks/${taskId}/comments`, {
      body: { comment },
    });
    return response.data;
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

    for (let page = 2; page <= totalPages; page++) {
      const next = await this.#requestPage<T>(path, query, page);
      items.push(...(next.data ?? []));
    }

    return items;
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
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.#config.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new Error(`Vikunja ${method} ${path} failed: ${describeCause(cause)}`, { cause });
    }

    const text = await response.text();

    if (!response.ok) {
      throw new Error(formatHttpError(method, path, response.status, text));
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
function formatHttpError(method: string, path: string, status: number, body: string): string {
  let detail = body.trim();

  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
      const { message, code } = parsed as { message: unknown; code?: unknown };
      if (typeof message === "string") {
        detail = typeof code === "number" ? `${message} (code ${code})` : message;
      }
    }
  } catch {
    // Not JSON — keep the raw body.
  }

  return `Vikunja ${method} ${path} -> HTTP ${status}: ${detail === "" ? "<empty body>" : truncate(detail)}`;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.name === "TimeoutError"
      ? `no response within ${REQUEST_TIMEOUT_MS} ms`
      : cause.message;
  }
  return String(cause);
}

function truncate(text: string, limit = 500): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
