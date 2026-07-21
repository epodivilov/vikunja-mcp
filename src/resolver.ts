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

/**
 * Project identifier -> the ids that claim it. A list, not an id: Vikunja enforces identifier
 * uniqueness case-sensitively, so `VMCP` and `vmcp` can both exist, and the lookup here is
 * case-insensitive because that is how keys arrive.
 */
type ProjectMap = Map<string, number[]>;

const BARE_NUMBER = /^\d+$/;
/** `#41` is what Vikunja renders for a project that has no identifier. */
const ANONYMOUS_REF = /^#\d+$/;
/** Identifiers are upper-case alphanumerics in the UI; dashes are allowed for the same reason. */
const PREFIX = /^[A-Za-z0-9_-]+$/;

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
 */
export function formatRef(projectIdentifier: string, index: number): string {
  return projectIdentifier === "" ? `#${index}` : `${projectIdentifier}-${index}`;
}

export class Resolver {
  readonly #client: ResolverClient;

  /**
   * The in-flight promise, not the resolved map, so concurrent tool calls on a cold cache share
   * one `GET /projects` instead of racing to issue their own.
   */
  #projects: Promise<ProjectMap> | null = null;

  constructor(client: ResolverClient) {
    this.#client = client;
  }

  /** `INFRA` -> project id. */
  async resolveProjectKey(key: string): Promise<number> {
    const prefix = key.trim().toUpperCase();

    if (!PREFIX.test(prefix)) {
      throw new Error(`"${key}" is not a project key. Expected an identifier such as INFRA.`);
    }

    return this.#projectId(prefix);
  }

  /**
   * `INFRA-41` -> global task id.
   *
   * One request: v2.3.0 accepts `index` in a filter expression, so the key resolves without
   * walking the project's task list. (v2.4.0 adds `GET /projects/{id}/tasks/by-index/{index}`,
   * which would replace the filter with a path — this method is the only place that would change.)
   */
  async resolveTaskRef(ref: string): Promise<number> {
    const { prefix, index } = parseTaskRef(ref);
    const projectId = await this.#projectId(prefix);
    const tasks = await this.#client.listTasks({
      filter: `project_id = ${projectId} && index = ${index}`,
    });

    // Matched rather than taken from tasks[0]: a server that does not honour the `index` term
    // answers with the whole project, and the first row of that is a different task entirely.
    // Returning the wrong task silently is the failure this module exists to prevent.
    const match = tasks.find((task) => task.index === index && task.project_id === projectId);

    if (match === undefined) {
      throw new Error(
        `No task ${prefix}-${index}: project ${prefix} (id ${projectId}) has no task with index ${index}.`,
      );
    }

    return match.id;
  }

  /**
   * An unknown prefix triggers exactly one reload before it is reported missing — a project
   * created after this process started is the common case, and a permanent 404 for it would
   * make the cache a liability. Bounded at one so a typo does not re-list projects on every call.
   */
  async #projectId(prefix: string): Promise<number> {
    const cached = (await this.#projectMap(false)).get(prefix);
    const ids = cached ?? (await this.#projectMap(true)).get(prefix);
    const [id, ...rest] = ids ?? [];

    if (id === undefined) {
      throw new Error(`No project has the key "${prefix}". List projects to see the keys in use.`);
    }

    if (rest.length > 0) {
      throw new Error(
        `The key "${prefix}" belongs to ${rest.length + 1} projects (ids ${[id, ...rest].join(", ")}), so a task key using it is ambiguous. Address the task as { id: <global id> }.`,
      );
    }

    return id;
  }

  #projectMap(reload: boolean): Promise<ProjectMap> {
    if (!reload && this.#projects !== null) {
      return this.#projects;
    }

    const pending = this.#load();
    this.#projects = pending;

    // A failed load must not be cached as the answer, or one network blip would leave the
    // resolver permanently unable to see any project.
    pending.catch(() => {
      if (this.#projects === pending) {
        this.#projects = null;
      }
    });

    return pending;
  }

  async #load(): Promise<ProjectMap> {
    const map: ProjectMap = new Map();

    for (const project of await this.#client.listProjects()) {
      // Projects without an identifier have no key and cannot be addressed by one.
      if (project.identifier === "") {
        continue;
      }

      const key = project.identifier.toUpperCase();
      const ids = map.get(key);

      if (ids === undefined) {
        map.set(key, [project.id]);
      } else {
        ids.push(project.id);
      }
    }

    return map;
  }
}
