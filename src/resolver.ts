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
import type {
  BoardMode,
  RawBucket,
  RawLabel,
  RawProject,
  RawTask,
  RawUser,
  RawView,
} from "./types.js";

/**
 * The slice of the client this module needs. Declared structurally rather than importing
 * `VikunjaClient` so a test can hand over a handful of functions instead of standing up an HTTP
 * server.
 */
export interface ResolverClient {
  listProjects(): Promise<RawProject[]>;
  listTasks(query: TaskQuery): Promise<RawTask[]>;
  listLabels(): Promise<RawLabel[]>;
  listViews(projectId: number): Promise<RawView[]>;
  listBuckets(projectId: number, viewId: number): Promise<RawBucket[]>;
  listProjectUsers(projectId: number): Promise<RawUser[]>;
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

/**
 * An incremental change to the labels a task carries, in the vocabulary the tool receives it in.
 *
 * The two sides are not symmetric, and deliberately so — see `Resolver.resolveLabelChange`.
 */
export interface LabelChange {
  /** Labels to end up on the task, named against the instance's labels. */
  add?: readonly LabelRef[] | undefined;
  /** Labels to end up off it, named against the ones the task already carries. */
  remove?: readonly LabelRef[] | undefined;
}

/**
 * A user as an agent names one: the username it reads in a member listing or on a task, or — when
 * that username turns out to be shared — the global id printed beside it.
 */
export type UserRef = string | number;

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
   * The labels a task should end up carrying after an incremental change: `(current ∪ add) \
   * remove`, as one set for the bulk endpoint to reconcile to.
   *
   * Computing the whole set here rather than firing per-label writes is what makes the change
   * atomic — one request, one transaction, no ordering between the adds and the removes — and it
   * costs nothing, since `current` came back with the task the caller already resolved.
   *
   * The two sides are resolved against different things, which is the substance of this method:
   *
   * - `add` may name a label the task does not have, so it is resolved against the instance
   *   (`resolveLabelIds`), where a title two labels share is genuinely ambiguous and is refused.
   * - `remove` can only mean a label the task actually carries, so it is matched against
   *   `current`. That resolves a shared title without asking — only one of them is on this task —
   *   and makes a reference matching nothing a no-op rather than an error, which is the whole of
   *   the idempotence R2 asks for. Resolving removes instance-wide would reintroduce both
   *   problems, and `LeanTask` reports label titles only, so an agent has no id to disambiguate
   *   with anyway.
   *
   * Two calls are refused outright, before anything is written: one naming no label at all (it
   * would write the set back unchanged and report success for a change nobody made), and one
   * naming the same label on both sides (the formula would silently let `remove` win, and the
   * caller cannot have meant both).
   *
   * That second refusal is checked twice, deliberately. The references are compared **as
   * written** first, which catches the mistake whatever the task currently carries — the same id,
   * or the same title, on both sides is wrong on its face. It has to be checked there, because
   * the resolved comparison below cannot see it: `removeIds` holds only labels the task already
   * has, so a collision over a label it does not have would slip through and *attach* the very
   * label the caller asked to remove. It would also make the refusal depend on prior state — the
   * same call succeeding once and failing the next time — which is exactly what the tool's
   * `idempotentHint` promises it will not do. The resolved check then stays for the collision the
   * written one cannot see: one label named by its title on one side and by its id on the other.
   */
  async resolveLabelChange(current: readonly RawLabel[], change: LabelChange): Promise<number[]> {
    const add = change.add ?? [];
    const remove = change.remove ?? [];

    if (add.length === 0 && remove.length === 0) {
      throw new Error(
        "Nothing to change: name at least one label in add or in remove. To replace a task's labels wholesale, or to clear them, use vikunja_set_task_labels.",
      );
    }

    const written = refsInBoth(add, remove);

    if (written.length > 0) {
      throw namedInBothError(written.map(describeRef).join(", "));
    }

    const addIds = await this.resolveLabelIds(add);
    const removeIds = labelsOnTask(current, remove);
    const both = addIds.filter((id) => removeIds.includes(id));

    if (both.length > 0) {
      throw namedInBothError(both.map((id) => `"${titleOf(current, id)}" (id ${id})`).join(", "));
    }

    const next = new Set(current.map((label) => label.id));

    for (const id of addIds) {
      next.add(id);
    }
    for (const id of removeIds) {
      next.delete(id);
    }

    return [...next];
  }

  /**
   * The users to assign, given who is already assigned: usernames mapped to ids against the
   * project's member listing, ids passed through, and everyone already on the task dropped.
   *
   * Three rules, each with a reason the layer above cannot supply:
   *
   * - **A username is matched against the project's members**, case-insensitively and locally.
   *   The listing's own search parameter matches fuzzily over name, username and email, so it
   *   cannot identify one user. A username two members share is reported with both ids rather
   *   than resolved to the lower one — usernames are unique only case-sensitively on SQLite, the
   *   same trap as project identifiers and label titles.
   * - **A number is passed straight through, ungated.** Whether a user may be assigned is the
   *   server's own project-access check, and its member listing has a hole: it seeds the id map
   *   from the addressed project's owner only, while access is granted if any *parent's* owner
   *   matches — so the owner of a parent project can be assigned but is not listed. Refusing an
   *   id here would be stricter than the server, which is never this module's job.
   * - **Already-assigned users produce no write**, matched by id so the skip does not depend on
   *   how the caller spelled them. `PUT /tasks/{id}/assignees` refuses a duplicate with code
   *   4021, which would abort a multi-user call halfway through with some users assigned.
   *
   * The listing is fetched lazily and once: a call naming only ids costs no request at all.
   * Nothing is written by this method — the caller writes only what comes back, so an unresolvable
   * name leaves the task exactly as it was.
   */
  async resolveAssigneeIds(
    projectId: number,
    assigned: readonly RawUser[],
    users: readonly UserRef[],
  ): Promise<number[]> {
    if (users.length === 0) {
      return [];
    }

    const assignedIds = new Set(assigned.map((user) => user.id));
    // Keyed by id, so the same user named twice — or once by username and once by id — is
    // written once. The second write would be the 4021 refusal above.
    const ids = new Set<number>();
    let members: RawUser[] | undefined;

    for (const user of users) {
      let id: number;

      if (typeof user === "number") {
        id = user;
      } else {
        members ??= await this.#client.listProjectUsers(projectId);
        id = memberByUsername(members, user);
      }

      if (!assignedIds.has(id)) {
        ids.add(id);
      }
    }

    return [...ids];
  }

  /**
   * The users to unassign, resolved against the task's *current assignees* rather than the
   * project's members — which is both narrower and wider than the member listing, and correct on
   * both counts: someone who left the project is still assigned and must stay removable, while
   * someone who never was assigned must not be silently "unassigned".
   *
   * That second half is the whole point. `DELETE /tasks/{t}/assignees/{u}` is a bare delete: it
   * never checks that the assignment existed and answers 200 either way, so without this refusal
   * a typo comes back as a cheerful success and an unchanged task. The message names who *is*
   * assigned, so the caller can correct itself without a second read.
   *
   * Synchronous, and the only resolver method that is: the candidate set arrives with the task
   * the caller already read, so there is nothing to fetch.
   */
  resolveUnassigneeIds(assigned: readonly RawUser[], users: readonly UserRef[]): number[] {
    if (users.length === 0) {
      return [];
    }

    if (assigned.length === 0) {
      throw new Error("This task has no assignees, so there is nothing to unassign.");
    }

    const ids = new Set<number>();

    for (const user of users) {
      ids.add(
        typeof user === "number"
          ? assignedById(assigned, user)
          : assignedByUsername(assigned, user),
      );
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

/**
 * The labels of `current` that `refs` name — the removal side of a label change.
 *
 * Every match is kept rather than just the first: a task carrying two labels that share a title
 * is named by that title exactly as much as one carrying a single label is, and dropping one of
 * the two would leave the task labelled with something the caller asked to be rid of. Nothing
 * matching is not an error, and that is the point of matching against the task rather than the
 * instance — a removal of a label that is not there has already happened.
 */
function labelsOnTask(current: readonly RawLabel[], refs: readonly LabelRef[]): number[] {
  const ids = new Set<number>();

  for (const ref of refs) {
    if (typeof ref === "number") {
      for (const label of current) {
        if (label.id === ref) {
          ids.add(label.id);
        }
      }
      continue;
    }

    const wanted = ref.trim().toLowerCase();

    if (wanted === "") {
      throw new Error('A label is named by its title, e.g. "bug", or by its id.');
    }

    for (const label of current) {
      if (label.title.trim().toLowerCase() === wanted) {
        ids.add(label.id);
      }
    }
  }

  return [...ids];
}

/** The title of a label the task carries. Only ever called for an id taken from that same set. */
function titleOf(current: readonly RawLabel[], id: number): string {
  return current.find((label) => label.id === id)?.title ?? String(id);
}

/**
 * The references `add` and `remove` both name, compared as the caller wrote them: a title against
 * a title (trimmed, case-insensitively, the way every other title match here works) and an id
 * against an id. No listing is needed to see this collision, which is why it is checked first —
 * and it is the only check that sees one over a label the task does not currently carry.
 *
 * A title and a number never compare equal here, even when they name the same label; that
 * collision is the resolved check's to catch, once there are ids on both sides to compare.
 */
function refsInBoth(add: readonly LabelRef[], remove: readonly LabelRef[]): LabelRef[] {
  const removed = new Set(remove.map(normaliseRef));
  const reported = new Set<string | number>();
  const both: LabelRef[] = [];

  for (const ref of add) {
    const key = normaliseRef(ref);

    if (removed.has(key) && !reported.has(key)) {
      reported.add(key);
      both.push(ref);
    }
  }

  return both;
}

/** A reference as a comparable key. Numbers stay numbers, so `5` never matches the title "5". */
function normaliseRef(ref: LabelRef): string | number {
  return typeof ref === "number" ? ref : ref.trim().toLowerCase();
}

/** A reference echoed back to the caller in the words they used. */
function describeRef(ref: LabelRef): string {
  return typeof ref === "number" ? `the label with id ${ref}` : `"${ref}"`;
}

/**
 * The one sentence both collision checks tell, so a caller cannot get two different stories about
 * the same mistake depending on which of them noticed it.
 */
function namedInBothError(named: string): Error {
  return new Error(
    `Named in both add and remove: ${named}. A label cannot be added and removed in the same call, and which one wins is not something to guess at — name it on one side only.`,
  );
}

/** Everyone currently assigned, as the error messages name them: `alice (id 3)`. */
function describeAssignees(assigned: readonly RawUser[]): string {
  return assigned.map((user) => `${user.username} (id ${user.id})`).join(", ");
}

/**
 * The one username match, or an error. Shared by both directions so that "which of these people
 * did you mean" reads the same whether the candidates are project members or task assignees.
 *
 * Case-insensitive, because the UI shows one casing and an agent will type another — and for
 * exactly that reason it can match two users at once: username uniqueness is a DB index, and on
 * SQLite the comparison is case-sensitive, so `Alice` and `alice` coexist. Both ids are reported
 * rather than one of them chosen.
 */
function userByUsername(candidates: readonly RawUser[], username: string, missing: string): number {
  const wanted = username.trim().toLowerCase();

  if (wanted === "") {
    throw new Error('A user is named by their username, e.g. "alice", or by their global id.');
  }

  const [match, ...rest] = candidates.filter(
    (user) => user.username.trim().toLowerCase() === wanted,
  );

  if (match === undefined) {
    throw new Error(missing);
  }

  if (rest.length > 0) {
    const ids = [match, ...rest].map((user) => user.id).join(", ");
    throw new Error(
      `The username "${username}" belongs to ${rest.length + 1} users (ids ${ids}), so it does not name one. Pass the id of the user you mean instead of the username.`,
    );
  }

  return match.id;
}

function memberByUsername(members: readonly RawUser[], username: string): number {
  return userByUsername(
    members,
    username,
    `No member of this project is called "${username}". List its members with vikunja_list_members to see who can be assigned, or pass a global user id if you have one.`,
  );
}

function assignedByUsername(assigned: readonly RawUser[], username: string): number {
  return userByUsername(
    assigned,
    username,
    `"${username}" is not assigned to this task, so there is nothing to remove. Assigned: ${describeAssignees(assigned)}.`,
  );
}

function assignedById(assigned: readonly RawUser[], id: number): number {
  const user = assigned.find((candidate) => candidate.id === id);

  if (user === undefined) {
    throw new Error(
      `No user with id ${id} is assigned to this task, so there is nothing to remove. Assigned: ${describeAssignees(assigned)}.`,
    );
  }

  return user.id;
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
