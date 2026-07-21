/**
 * Keys <-> ids. `INFRA-41` is the only address a human or an agent ever sees, while the REST
 * API addresses tasks by a global `id` that appears nowhere in the UI. Every layer above this
 * one speaks keys; this module is where they become ids.
 *
 * It sits above `client` and below the tools: it knows what a key means and how Vikunja stores
 * it, so the tools do not have to. Nothing here performs I/O directly — it goes through the
 * injected client, which keeps the one-host rule enforced in a single place.
 */
import type { TaskQuery } from "./client.js";
import type { RawProject, RawTask } from "./types.js";

/**
 * The slice of the client this module needs. Declared structurally rather than importing
 * `VikunjaClient` so a test can hand over two functions instead of standing up an HTTP server.
 */
export interface ResolverClient {
  listProjects(): Promise<RawProject[]>;
  listTasks(query: TaskQuery): Promise<RawTask[]>;
}

/** A task key split into the parts Vikunja stores separately. */
export interface TaskRef {
  /** Project identifier, upper-cased: `INFRA`. */
  prefix: string;
  /** Per-project sequence number: `41`. */
  index: number;
}

/** A project as the key map remembers it. `archived` decides which failure a missing task is. */
interface ProjectEntry {
  id: number;
  archived: boolean;
}

/**
 * Project identifier -> the projects that claim it. A list, not one project: Vikunja enforces
 * identifier uniqueness case-sensitively, so `VMCP` and `vmcp` can both exist, and the lookup
 * here is case-insensitive because that is how keys arrive.
 */
type ProjectMap = Map<string, ProjectEntry[]>;

/** Which escape hatch an ambiguous prefix should point at — a task and a project differ. */
type Subject = "task" | "project";

const BARE_NUMBER = /^\d+$/;
/** `#41` is what Vikunja renders for a project that has no identifier. */
const ANONYMOUS_REF = /^#\d+$/;
/** Identifiers are upper-case alphanumerics in the UI; dashes are allowed for the same reason. */
const PREFIX = /^[A-Za-z0-9_-]+$/;

/**
 * How long a loaded project map answers "no such prefix" on its own authority. Past it, one
 * miss buys one `GET /projects` — enough to pick up a project created since, without turning a
 * mistyped key into a listing per call.
 */
const RELOAD_INTERVAL_MS = 30_000;

/**
 * Splits `INFRA-41` into prefix and index.
 *
 * A bare `41` is rejected rather than guessed at: it is the global id in some contexts and a
 * per-project index in others, and picking either silently addresses the wrong task. That
 * ambiguity is the whole reason this project exists, so it is answered with an error that names
 * the escape hatch instead of a heuristic.
 */
export function parseTaskRef(input: string): TaskRef {
  const ref = input.trim();

  if (ref === "") {
    throw new Error("A task key is required, e.g. INFRA-41.");
  }

  if (BARE_NUMBER.test(ref)) {
    throw new Error(
      `"${ref}" is a bare number, and a task is addressed by key — e.g. INFRA-41. If you really mean the global id, pass it as { id: ${ref} }.`,
    );
  }

  if (ANONYMOUS_REF.test(ref)) {
    throw new Error(
      `"${ref}" is how Vikunja renders a task in a project that has no key prefix, so it does not identify a task on its own. Address it as { id: <global id> }, or give the project an identifier.`,
    );
  }

  // The last dash, not the first: an identifier may itself contain one (`MY-TEAM-41`).
  const split = ref.lastIndexOf("-");
  const prefix = split === -1 ? "" : ref.slice(0, split);
  const digits = ref.slice(split + 1);

  if (!PREFIX.test(prefix) || !BARE_NUMBER.test(digits)) {
    throw new Error(`"${ref}" is not a task key. Expected <PROJECT>-<number>, e.g. INFRA-41.`);
  }

  const index = Number.parseInt(digits, 10);

  if (index < 1 || !Number.isSafeInteger(index)) {
    throw new Error(`"${ref}" carries an out-of-range index; task numbering starts at 1.`);
  }

  return { prefix: prefix.toUpperCase(), index };
}

/**
 * Renders a key from the two fields it is actually made of.
 *
 * Deliberately not `RawTask.identifier`: the server fills that in on a read but not on the
 * response to an update, where it merely echoes whatever the request carried. Deriving the key
 * from `index` is correct on every path.
 *
 * The `#41` an identifier-less project produces is a rendering, not an address: `parseTaskRef`
 * rejects it, because it names no project. Such a task is reachable only by its global id.
 */
export function formatRef(projectIdentifier: string, index: number): string {
  return projectIdentifier === "" ? `#${index}` : `${projectIdentifier}-${index}`;
}

export interface ResolverOptions {
  /**
   * How long the project map is trusted before a missing prefix may trigger a reload. Lower
   * values exist to exercise the reload path in tests; production uses the default.
   */
  reloadIntervalMs?: number;
}

export class Resolver {
  readonly #client: ResolverClient;
  readonly #reloadIntervalMs: number;

  /**
   * The in-flight promise, not the resolved map, so concurrent tool calls on a cold cache share
   * one `GET /projects` instead of racing to issue their own.
   */
  #projects: Promise<ProjectMap> | null = null;

  /** When the map currently in `#projects` arrived; 0 while none has. */
  #loadedAt = 0;

  /** A reload in flight, shared so that concurrent misses do not each buy their own listing. */
  #reloading: Promise<ProjectMap> | null = null;

  constructor(client: ResolverClient, options: ResolverOptions = {}) {
    this.#client = client;
    this.#reloadIntervalMs = options.reloadIntervalMs ?? RELOAD_INTERVAL_MS;
  }

  /** `INFRA` -> project id. */
  async resolveProjectKey(key: string): Promise<number> {
    const prefix = key.trim().toUpperCase();

    if (!PREFIX.test(prefix)) {
      throw new Error(`"${key}" is not a project key. Expected an identifier such as INFRA.`);
    }

    return (await this.#project(prefix, "project")).id;
  }

  /**
   * `INFRA-41` -> the task itself.
   *
   * One request: v2.3.0 accepts `index` in a filter expression, so the key resolves without
   * walking the project's task list. (v2.4.0 adds `GET /projects/{id}/tasks/by-index/{index}`,
   * which would replace the filter with a path — this method is the only place that would change.)
   *
   * The task is returned rather than only its id because that request already paid for it, and
   * the caller that wants to read it would otherwise fetch the same row again. Callers needing
   * just the id take `.id`.
   */
  async resolveTask(ref: string): Promise<RawTask> {
    const { prefix, index } = parseTaskRef(ref);
    const project = await this.#project(prefix, "task");
    const projectId = project.id;
    const tasks = await this.#client.listTasks({
      filter: `project_id = ${projectId} && index = ${index}`,
    });

    // Matched rather than taken from tasks[0]: a server that does not honour the `index` term
    // answers with the whole project, and the first row of that is a different task entirely.
    // Returning the wrong task silently is the failure this module exists to prevent.
    const match = tasks.find((task) => task.index === index && task.project_id === projectId);

    if (match === undefined) {
      // An archived project answers `GET /tasks` with nothing at all — the collection is built
      // from the user's non-archived projects and takes no parameter to widen that (probed on
      // 2.3.0, where `GET /tasks/{id}` still returns the very task the filter omits). Saying the
      // index does not exist would be a lie; the key is simply not resolvable on this path.
      throw new Error(
        project.archived
          ? `Cannot resolve ${prefix}-${index}: project ${prefix} (id ${projectId}) is archived, and Vikunja does not list tasks of archived projects. Read the task as { id: <global id> }, or unarchive the project.`
          : `No task ${prefix}-${index}: project ${prefix} (id ${projectId}) has no task with index ${index}.`,
      );
    }

    return match;
  }

  /**
   * A prefix the map does not know is worth one `GET /projects` before it is called missing — a
   * project created after this process started is the common case, and a permanent "no such key"
   * for it would make the cache a liability. The reload is rate-limited rather than counted:
   * within `RELOAD_INTERVAL_MS` of the last successful load the map answers on its own, so a
   * mistyped key costs nothing and a cold start does not list projects twice in a row.
   */
  async #project(prefix: string, subject: Subject): Promise<ProjectEntry> {
    const map = await this.#projectMap();
    const entries = map.get(prefix) ?? (await this.#refresh(map)).get(prefix);
    const [project, ...rest] = entries ?? [];

    if (project === undefined) {
      throw new Error(`No project has the key "${prefix}". List projects to see the keys in use.`);
    }

    if (rest.length > 0) {
      const all = [project, ...rest].map((entry) => entry.id).join(", ");
      throw new Error(
        subject === "task"
          ? `The key "${prefix}" belongs to ${rest.length + 1} projects (ids ${all}), so a task key using it is ambiguous. Address the task as { id: <global id> }.`
          : `The key "${prefix}" belongs to ${rest.length + 1} projects (ids ${all}), so it does not identify one. Address the project by its id: one of ${all}.`,
      );
    }

    return project;
  }

  /** The cold path: one load, shared by everyone who arrives while it is in flight. */
  #projectMap(): Promise<ProjectMap> {
    if (this.#projects !== null) {
      return this.#projects;
    }

    const pending = this.#load();
    this.#projects = pending;

    pending.then(
      () => {
        this.#loadedAt = Date.now();
      },
      () => {
        // A failed load must not be cached as the answer, or one network blip would leave the
        // resolver permanently unable to see any project.
        if (this.#projects === pending) {
          this.#projects = null;
        }
      },
    );

    return pending;
  }

  /** The miss path. Returns the map in hand when it is too fresh to be worth re-listing. */
  #refresh(current: ProjectMap): Promise<ProjectMap> {
    if (Date.now() - this.#loadedAt < this.#reloadIntervalMs) {
      return Promise.resolve(current);
    }

    this.#reloading ??= this.#reload();

    return this.#reloading;
  }

  /**
   * Publishes the new map only once it has arrived. Assigning the in-flight promise instead
   * would put a load that has not succeeded — and may not — in front of a map that answers
   * correctly, so an unrelated lookup of a known prefix would fail on someone else's typo.
   */
  async #reload(): Promise<ProjectMap> {
    try {
      const map = await this.#load();
      this.#projects = Promise.resolve(map);
      this.#loadedAt = Date.now();
      return map;
    } finally {
      this.#reloading = null;
    }
  }

  async #load(): Promise<ProjectMap> {
    const map: ProjectMap = new Map();

    for (const project of await this.#client.listProjects()) {
      // Projects without an identifier have no key and cannot be addressed by one.
      if (project.identifier === "") {
        continue;
      }

      const key = project.identifier.toUpperCase();
      const entry: ProjectEntry = { id: project.id, archived: project.is_archived };
      const entries = map.get(key);

      if (entries === undefined) {
        map.set(key, [entry]);
      } else {
        entries.push(entry);
      }
    }

    return map;
  }
}
