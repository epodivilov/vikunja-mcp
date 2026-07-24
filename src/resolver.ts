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
import type { BoardMode, RawBucket, RawLabel, RawProject, RawTask, RawView } from "./types.js";

/**
 * The slice of the client this module needs. Declared structurally rather than importing
 * `VikunjaClient` so a test can hand over three functions instead of standing up an HTTP server.
 */
export interface ResolverClient {
  listProjects(): Promise<RawProject[]>;
  listTasks(query: TaskQuery): Promise<RawTask[]>;
  listLabels(): Promise<RawLabel[]>;
  listViews(projectId: number): Promise<RawView[]>;
  listBuckets(projectId: number, viewId: number): Promise<RawBucket[]>;
}

/** A project's kanban view, located: the view id to address the board by, and its bucket mode. */
export interface KanbanView {
  id: number;
  mode: BoardMode;
}

/**
 * A label as an agent names it: the title it reads in a listing, or — when that title turns out
 * to be shared — the id printed beside it.
 */
export type LabelRef = string | number;

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

/**
 * One `GET /projects`, indexed both ways a caller can arrive: by key and by global id.
 *
 * The id index is not a mirror of the key one. It holds the projects a key can never name —
 * those with an empty identifier — because the id is precisely the address used for them, and
 * it answers the question the key index cannot: whether the project behind a raw id is archived,
 * and therefore whether a task query naming it can return anything at all.
 */
interface ProjectIndex {
  byKey: ProjectMap;
  byId: Map<number, ProjectEntry>;
}

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
 * Normalises a project key: `infra` -> `INFRA`.
 *
 * A bare `11` is refused for the same reason `parseTaskRef` refuses one — it is a global id
 * wearing a key's clothes. Vikunja would otherwise be asked for a project whose identifier is
 * literally "11" and would answer "no project has that key", which reads as a missing project
 * when the real mistake was an id in the key's place.
 *
 * The rule lives here rather than in a tool so that every caller of a project key gets the same
 * refusal. A tool-local copy only guards the one tool that remembers to run it.
 */
export function parseProjectKey(input: string): string {
  const key = input.trim();

  if (key === "") {
    throw new Error("A project key is required, e.g. INFRA.");
  }

  if (BARE_NUMBER.test(key)) {
    throw new Error(
      `"${key}" is a bare number, and a project is addressed by its key — e.g. INFRA. If you really mean the global id, pass it as { projectId: ${key} }.`,
    );
  }

  if (!PREFIX.test(key)) {
    throw new Error(`"${input}" is not a project key. Expected an identifier such as INFRA.`);
  }

  return key.toUpperCase();
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
   * The in-flight promise, not the resolved index, so concurrent tool calls on a cold cache
   * share one `GET /projects` instead of racing to issue their own.
   */
  #projects: Promise<ProjectIndex> | null = null;

  /** When the index currently in `#projects` arrived; 0 while none has. */
  #loadedAt = 0;

  /** A reload in flight, shared so that concurrent misses do not each buy their own listing. */
  #reloading: Promise<ProjectIndex> | null = null;

  constructor(client: ResolverClient, options: ResolverOptions = {}) {
    this.#client = client;
    this.#reloadIntervalMs = options.reloadIntervalMs ?? RELOAD_INTERVAL_MS;
  }

  /** `INFRA` -> project id. */
  async resolveProjectKey(key: string): Promise<number> {
    const prefix = parseProjectKey(key);

    return (await this.#project(prefix, "project")).id;
  }

  /**
   * `INFRA` -> project id, for narrowing a task query to it.
   *
   * Refuses an archived project rather than handing back an id that queries fine and matches
   * nothing. `GET /tasks` builds its collection from the user's non-archived projects and takes
   * no parameter to widen it, so a filter naming an archived project answers `[]` — a result
   * shaped exactly like "this project has no tasks", which is a different and false statement.
   * `resolveTask` already refuses a key in an archived project for the same reason; this is the
   * same refusal on the listing path, so the two tools stop telling different stories about the
   * same project.
   */
  async resolveProjectForTasks(key: string): Promise<number> {
    const prefix = parseProjectKey(key);
    const project = await this.#project(prefix, "project");

    if (project.archived) {
      throw archivedProjectError(`${prefix} (id ${project.id})`);
    }

    return project.id;
  }

  /**
   * A global project id, checked before a task query is narrowed to it.
   *
   * The id escape hatch reached the same two silent-empty answers the key path used to give, so
   * it gets the same two refusals. An archived project is refused for the reason above. An id
   * that names no project at all is refused too, rather than passed through to a filter that
   * would answer `[]`: "this project has no tasks" and "there is no such project" are different
   * facts, and only one of them is true. The key path has always drawn that line — an unknown
   * key is an error, not an empty list — and the point of this method is that both inputs to one
   * tool behave alike.
   *
   * A miss buys the same rate-limited reload a missing key does, so an id created since this
   * process started is picked up rather than denied on a stale index.
   */
  async checkProjectIdForTasks(id: number): Promise<number> {
    const index = await this.#index();
    const project = index.byId.get(id) ?? (await this.#refresh(index)).byId.get(id);

    if (project === undefined) {
      throw new Error(
        `No project has id ${id}. List projects to see the ids in use, and prefer the project key.`,
      );
    }

    if (project.archived) {
      throw archivedProjectError(`project ${id}`);
    }

    return id;
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
   * Label titles -> the ids the task/label endpoint takes.
   *
   * Titles are not unique: Vikunja enforces nothing there, and the instance this was built
   * against carries three labels called "feature" and three called "bug", so the collision is
   * the normal case rather than a corner one. An ambiguous title is therefore reported
   * instead of resolved to the lower id — picking one silently is the class of bug this module
   * exists to prevent — and the error names the ids to choose between. A number is taken as a
   * label id and still checked against the listing, so every label in a call is validated
   * before the caller writes anything and a typo cannot leave a half-labelled task behind.
   *
   * Deliberately uncached: labels are read once per write that carries them, which is rare, and
   * a cache would answer "no such label" for one created a moment ago in the UI.
   */
  async resolveLabelIds(labels: readonly LabelRef[]): Promise<number[]> {
    if (labels.length === 0) {
      return [];
    }

    const known = await this.#client.listLabels();
    // A Set keyed by id: the same label named twice, or named once by title and once by id,
    // would otherwise be attached twice — and the second attach is an error (code 8001).
    const ids = new Set<number>();

    for (const label of labels) {
      ids.add(typeof label === "number" ? labelById(known, label) : labelByTitle(known, label));
    }

    return [...ids];
  }

  /**
   * A project's kanban view: the first by display order, with the mode that decides whether a
   * task moves by a bucket operation (`manual`) or by changing the fields its column filters on
   * (`filter`). A project can hold several kanban views; taking the first by `position` is
   * deliberate and stated, never a silent merge of columns across views.
   *
   * A project with no kanban view has no board at all, which is a different fact from an empty
   * board — so it is an error naming the absence, not an empty result the caller would misread as
   * "the board has no columns".
   */
  async resolveKanbanView(projectId: number): Promise<KanbanView> {
    const [first] = (await this.#client.listViews(projectId))
      .filter((view) => view.view_kind === "kanban")
      .sort((a, b) => a.position - b.position);

    if (first === undefined) {
      throw new Error(
        `Project ${projectId} has no kanban view, so there is no board to read. Add a kanban view in Vikunja, or list its tasks with vikunja_list_tasks.`,
      );
    }

    // Only a manual board is movable by bucket. Anything that is not "manual" is treated as
    // filter, so an unexpected mode refuses a move rather than attempting a bucket op that cannot
    // apply — the safe default, since a filter board has no `task_buckets` rows to write.
    return {
      id: first.id,
      mode: first.bucket_configuration_mode === "manual" ? "manual" : "filter",
    };
  }

  /**
   * A column name -> its bucket id, within one manual view, for a move.
   *
   * Bucket titles are not unique — Vikunja enforces nothing there — so a shared name is reported
   * as ambiguous rather than resolved to one, the same "never guess" rule this module applies to
   * project keys and label titles. An unknown name lists the columns that do exist. The resolved
   * id is used only to build the move URL and never leaves this layer; the ambiguity error names
   * the count, not the ids, because a numeric bucket id is not an address the model may hold.
   */
  async resolveBucketId(projectId: number, viewId: number, column: string): Promise<number> {
    const wanted = column.trim().toLowerCase();

    if (wanted === "") {
      throw new Error('A column is named by its title, e.g. "Doing".');
    }

    const buckets = await this.#client.listBuckets(projectId, viewId);
    const [match, ...rest] = buckets.filter(
      (bucket) => bucket.title.trim().toLowerCase() === wanted,
    );

    if (match === undefined) {
      const names = buckets.map((bucket) => `"${bucket.title}"`).join(", ");
      throw new Error(
        `This board has no column named "${column}". Its columns are: ${names || "(none)"}.`,
      );
    }

    if (rest.length > 0) {
      throw new Error(
        `This board has ${rest.length + 1} columns named "${column}", so the name does not identify one. Rename one in Vikunja so the target is unambiguous.`,
      );
    }

    return match.id;
  }

  /**
   * A prefix the map does not know is worth one `GET /projects` before it is called missing — a
   * project created after this process started is the common case, and a permanent "no such key"
   * for it would make the cache a liability. The reload is rate-limited rather than counted:
   * within `RELOAD_INTERVAL_MS` of the last successful load the map answers on its own, so a
   * mistyped key costs nothing and a cold start does not list projects twice in a row.
   */
  async #project(prefix: string, subject: Subject): Promise<ProjectEntry> {
    const index = await this.#index();
    const entries = index.byKey.get(prefix) ?? (await this.#refresh(index)).byKey.get(prefix);
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
  #index(): Promise<ProjectIndex> {
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

  /** The miss path. Returns the index in hand when it is too fresh to be worth re-listing. */
  #refresh(current: ProjectIndex): Promise<ProjectIndex> {
    if (Date.now() - this.#loadedAt < this.#reloadIntervalMs) {
      return Promise.resolve(current);
    }

    this.#reloading ??= this.#reload();

    return this.#reloading;
  }

  /**
   * Publishes the new index only once it has arrived. Assigning the in-flight promise instead
   * would put a load that has not succeeded — and may not — in front of an index that answers
   * correctly, so an unrelated lookup of a known prefix would fail on someone else's typo.
   */
  async #reload(): Promise<ProjectIndex> {
    try {
      const index = await this.#load();
      this.#projects = Promise.resolve(index);
      this.#loadedAt = Date.now();
      return index;
    } finally {
      this.#reloading = null;
    }
  }

  async #load(): Promise<ProjectIndex> {
    const byKey: ProjectMap = new Map();
    const byId = new Map<number, ProjectEntry>();

    for (const project of await this.#client.listProjects()) {
      const entry: ProjectEntry = { id: project.id, archived: project.is_archived };

      // Indexed by id before the key check, deliberately: a project with no identifier is
      // exactly the one a caller has to address by id, so it must be in this map even though
      // no key will ever reach it.
      byId.set(project.id, entry);

      // Projects without an identifier have no key and cannot be addressed by one.
      if (project.identifier === "") {
        continue;
      }

      const key = project.identifier.toUpperCase();
      const entries = byKey.get(key);

      if (entries === undefined) {
        byKey.set(key, [entry]);
      } else {
        entries.push(entry);
      }
    }

    return { byKey, byId };
  }
}

/**
 * The one sentence both listing paths tell about an archived project, so a key and an id cannot
 * drift into describing the same project differently.
 */
function archivedProjectError(subject: string): Error {
  return new Error(
    `Cannot list the tasks of ${subject}: the project is archived, and Vikunja does not list tasks of archived projects. Read a task of it as { id: <global id> }, or unarchive the project.`,
  );
}

function labelById(known: readonly RawLabel[], id: number): number {
  const label = known.find((candidate) => candidate.id === id);

  if (label === undefined) {
    throw new Error(`No label has id ${id}. List labels to see which ids exist.`);
  }

  return label.id;
}

function labelByTitle(known: readonly RawLabel[], title: string): number {
  const wanted = title.trim().toLowerCase();

  if (wanted === "") {
    throw new Error('A label is named by its title, e.g. "bug", or by its id.');
  }

  const [match, ...rest] = known.filter((label) => label.title.trim().toLowerCase() === wanted);

  if (match === undefined) {
    throw new Error(`No label is titled "${title}". List labels to see the titles in use.`);
  }

  if (rest.length > 0) {
    const ids = [match, ...rest].map((label) => label.id).join(", ");
    throw new Error(
      `The title "${title}" belongs to ${rest.length + 1} labels (ids ${ids}), so it does not name one. Pass the id of the label you mean instead of its title.`,
    );
  }

  return match.id;
}
