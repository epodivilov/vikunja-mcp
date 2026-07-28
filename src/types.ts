/**
 * Lean DTOs returned to the agent. These are the ONLY task/project shapes that
 * cross the tool boundary — never expose a raw Vikunja API object to the model.
 */

export interface LeanProject {
  /** Project key prefix, e.g. "INFRA". Empty string if the project has no identifier. */
  key: string;
  id: number;
  title: string;
  /**
   * Present, and only ever `true`, when the project is archived; absent means live.
   *
   * Carried because an archived project is not a live one with a flag on it: Vikunja builds the
   * `GET /tasks` collection from non-archived projects only, so every task in it is invisible to
   * every task query. Rendering it identically to a live project invites a caller to ask a
   * question that can only come back empty.
   */
  archived?: true;
}

export interface LeanTask {
  /** Human/agent-facing task key, e.g. "INFRA-41". */
  ref: string;
  /** Global Vikunja id. Escape hatch only — prefer `ref` everywhere. */
  id: number;
  title: string;
  done: boolean;
  priority?: number;
  due?: string;
  labels: string[];
  /**
   * Usernames of the people this task is assigned to, omitted entirely when it has none.
   *
   * Usernames rather than ids, for the same reason tasks are addressed by key: the id is not what
   * a human or an agent reads anywhere. Omitted rather than `[]` because most tasks in a listing
   * carry no assignee, and an empty array on every row is pure token cost.
   */
  assignees?: string[];
}

/**
 * One related task, named the way everything else here is: by key. `kind` is Vikunja's own
 * vocabulary (`RELATION_KINDS`), read from the perspective of the task carrying the relation —
 * a `blocking` entry is a task this one blocks.
 *
 * `kind` is a plain string rather than `RelationKind`: these are the map keys the server sent,
 * and passing an unrecognised one through as the server spelled it beats dropping it silently
 * or claiming a type the value has not been checked against.
 */
export interface LeanRelation {
  kind: string;
  ref: string;
  title: string;
  done: boolean;
}

/**
 * A single task read in full. Only `vikunja_get_task` and the two relation tools return this
 * shape — list operations stay on `LeanTask` so a listing never carries descriptions.
 */
export interface LeanTaskDetail extends LeanTask {
  /** Markdown, converted from the HTML Vikunja stores. Omitted when empty. */
  description?: string;
  /** Related tasks across every kind. Omitted — not empty — when the task has none. */
  relations?: LeanRelation[];
}

/**
 * The relation vocabulary of Vikunja 2.3.0, as `RelationKind.isValid()` defines it. `unknown`
 * is deliberately absent: the constant exists in the Go source but the permission layer rejects
 * it, so offering it would advertise a kind every write refuses.
 *
 * Each kind has an inverse the server writes on the other task by itself: `blocking`/`blocked`,
 * `subtask`/`parenttask`, `precedes`/`follows`, `duplicateof`/`duplicates`,
 * `copiedfrom`/`copiedto`, and `related` with itself.
 *
 * This list and the guard below are the only runtime values in this module, and they live here
 * rather than beside the key parsers in `resolver` for a mechanical reason: the suite runs
 * `node --test` over the TypeScript, where a `.js` value specifier resolves to nothing. A
 * `src` module that imports another one's *value* stops being loadable by a test — and takes
 * every test importing it down as well. Nothing imports this module for anything but types, so
 * it is the one place a shared constant costs no coverage.
 */
export const RELATION_KINDS = [
  "subtask",
  "parenttask",
  "related",
  "duplicateof",
  "duplicates",
  "blocking",
  "blocked",
  "precedes",
  "follows",
  "copiedfrom",
  "copiedto",
] as const;

export type RelationKind = (typeof RELATION_KINDS)[number];

/**
 * A relation kind as Vikunja spells it, or an error naming the eleven it accepts.
 *
 * Checked before anything is resolved or written, for the same reason a task key is parsed
 * before it is looked up: the caller's own word is what is wrong, and saying so beats a 400 that
 * names a Go constant. A made-up kind therefore costs no request at all.
 *
 * In the two tools this is the inner of two gates, and the outer one is stricter: their schemas
 * declare `kind` as a zod enum, and the MCP SDK validates against it before a handler runs — so
 * over MCP a wrong kind is rejected there, and the trim/lower-case here is never what saves it.
 * The enum stays because it is what publishes the vocabulary to a client; this stays because it
 * is what any other caller gets, and because the refusal it writes names the eleven kinds in a
 * sentence rather than in a schema violation.
 */
export function parseRelationKind(input: string): RelationKind {
  const kind = input.trim().toLowerCase();
  const allowed = RELATION_KINDS.join(", ");

  if (kind === "") {
    throw new Error(`A relation kind is required. One of: ${allowed}.`);
  }

  const match = RELATION_KINDS.find((candidate) => candidate === kind);

  if (match === undefined) {
    throw new Error(
      `"${input}" is not a Vikunja relation kind. Use one of: ${allowed}. The kind is read from the named task's side — "blocking" means it blocks the other task.`,
    );
  }

  return match;
}

/**
 * Builds a task key out of the two fields it is actually made of. The projection needs a key
 * for a related task in some other project, and only the resolver knows that project's
 * identifier — so the resolver hands one of these down rather than the projection reaching up.
 */
export type TaskRefLookup = (projectId: number, index: number) => string;

export interface LeanLabel {
  id: number;
  title: string;
  /**
   * The stored colour, canonicalised: trimmed, `#` stripped, lower-cased — 34 of one live
   * instance's 39 labels hold `0EA5E9`-shaped values, so folding case here is what saves every
   * caller from doing it.
   *
   * Canonicalised, **not validated**. Six hex digits is what the write path demands
   * (`parseHexColor`); the read path reports whatever is stored, because the server accepts more
   * than it can render — `red` passes its `runelength(0|7)` check and is stored verbatim. A label
   * created outside this server can therefore surface a value no renderer understands, and
   * rewriting or dropping it here would be inventing data the instance does not hold.
   *
   * Absent, not `""`, when the label has no colour: the same rule every optional field here
   * follows, and the one that lets a listing stay as lean as it was.
   */
  color?: string;
}

/**
 * A user as the agent names one: by username, with the global id as the escape hatch for the
 * collision case. `name` is the display name, present only when the user has set one.
 *
 * No email — ever. The endpoint this is projected from blanks it out when no search term is
 * passed, but that is the server's accident, not a guarantee; dropping the field here is what
 * makes it one.
 */
export interface LeanUser {
  id: number;
  username: string;
  name?: string;
}

/**
 * One comment on a task. Addressed by `id`: comments have no per-task sequence and therefore no
 * key of their own, so the "keys, not ids" rule — which is about tasks and projects — does not
 * reach them.
 *
 * `author` is a username and nothing more. Vikunja sends the whole user object (name, email,
 * avatar settings, timestamps), which is exactly the expanded-owner bloat this server exists to
 * strip.
 */
export interface LeanComment {
  id: number;
  /** Markdown, converted from the HTML Vikunja stores. */
  comment: string;
  /** The author's username. Omitted when the server reports no usable one. */
  author?: string;
  /** RFC3339 timestamp, verbatim as stored — a real date, never Vikunja's zero value. */
  created: string;
}

/** Whether a kanban board's columns are hand-managed buckets or synthesized from per-column filters. */
export type BoardMode = "manual" | "filter";

/** One kanban column: a name and the lean tasks currently under it. A bucket id never crosses here. */
export interface LeanColumn {
  name: string;
  tasks: LeanTask[];
}

/**
 * A project's kanban board, projected for the agent: the columns in the server's own order, each
 * with its lean tasks, plus the mode that decides how a task moves — a bucket operation on a
 * `manual` board, a change to the fields its column filters on a `filter` one.
 */
export interface LeanBoard {
  mode: BoardMode;
  columns: LeanColumn[];
}

/**
 * Raw Vikunja API shapes — internal to `client` and `projection`. Only the fields we
 * actually read are declared; the server sends a great deal more, and none of it may
 * reach the model. These types never cross the tool boundary.
 */

export interface RawProject {
  id: number;
  title: string;
  /** Key prefix, e.g. "VMCP". Empty string when the project has no identifier. */
  identifier: string;
  description: string;
  is_archived: boolean;
}

/**
 * A label as the API returns one. `description` and `hex_color` are declared — and required, like
 * `RawTask`'s columns — because the update path has to carry them: `POST /labels/{id}` writes a
 * fixed `title` / `description` / `hex_color` set and zeroes whatever the payload omits, so a
 * rename that did not know about the other two would blank them.
 *
 * `created_by` (a whole user object) is deliberately absent: nothing here reads it, so nothing
 * here can leak it.
 */
export interface RawLabel {
  id: number;
  title: string;
  /** Exposed by no tool. Declared so an update can send it back rather than erase it. */
  description: string;
  /** Six hex digits without a leading `#`, in whatever case it was stored; `""` for no colour. */
  hex_color: string;
}

/**
 * A user as the API returns one, on a task's `assignees` and from the project-members listing.
 *
 * The server sends a good deal more — `email`, `created`, `updated` — and none of it is declared,
 * so nothing above can read it by accident. `name` is the display name and is `""` when unset,
 * like every other absent string Vikunja stores.
 */
export interface RawUser {
  id: number;
  username: string;
  name: string;
}

export interface RawTask {
  id: number;
  title: string;
  description: string;
  done: boolean;
  project_id: number;
  priority: number;
  /** Unset dates come back as "0001-01-01T00:00:00Z", not null. */
  due_date: string;
  /** Per-project sequence number; the key is `<project.identifier>-<index>`. */
  index: number;
  /**
   * Vikunja renders the key itself, e.g. "VMCP-2" — and falls back to "#<index>" when the
   * project has no identifier, so on a read this is never empty. An update response is the one
   * place the server does not fill it in: there it echoes whatever the payload carried.
   */
  identifier: string;
  labels: RawLabel[] | null;
  /**
   * Null when nobody is assigned, like `labels`. Declared because `client.updateTask` has to echo
   * it back: `POST /tasks/{id}` replaces the assignee set wholesale from its payload, so an update
   * that dropped this field would silently unassign everyone.
   */
  assignees: RawUser[] | null;
  /**
   * Related tasks, keyed by relation kind. Both read paths embed them: `GET /tasks/{id}`, and
   * the `GET /tasks` collection a key resolves through (`addRelatedTasksToTasks`), which
   * initializes the map and so sends at least `{}`. Three shapes mean "none": absent (an
   * endpoint that does not populate it, such as a write response), `null` (a nil Go map) and
   * `{}` (an empty one). The rows inside are whole tasks whose `identifier` is always `""` —
   * `setIdentifier` runs on the task being read and never on these — so their keys have to be
   * rebuilt from `index` and their own project.
   */
  related_tasks?: Record<string, RawTask[] | null> | null;
}

/**
 * A user as Vikunja expands it inside another object. Only `username` is declared: it is the one
 * field the projection reads, and the only one allowed past the tool boundary.
 */
export interface RawUser {
  username: string;
}

export interface RawComment {
  id: number;
  /** HTML, like task descriptions — stored verbatim, converted by nobody. */
  comment: string;
  /**
   * The full user object (`author` in the API), or null. The single-comment read always fills it
   * in; the listing looks each author up by id and leaves the field null when that lookup finds
   * nobody — a deleted user, or a comment written by a link share.
   */
  author: RawUser | null;
  /** RFC3339, e.g. "2026-07-24T18:21:09.315237Z". A real timestamp, not a nullable zero date. */
  created: string;
}

/**
 * A project view. Only the fields the board tools read are declared. On 2.3.0 both `view_kind`
 * and `bucket_configuration_mode` are strings — `"kanban"`, `"manual"`/`"filter"`/`"none"` — not
 * the integers an older reading of the API might expect.
 */
export interface RawView {
  id: number;
  /** Ascending display order; the first kanban view by position is the board. */
  position: number;
  /** "list" | "gantt" | "table" | "kanban". */
  view_kind: string;
  /** "none" on a non-kanban view; "manual" or "filter" on a kanban one. */
  bucket_configuration_mode: string;
}

/**
 * A kanban bucket. The view-tasks read embeds each bucket's `tasks` (in column order); the plain
 * buckets listing sends `tasks: null` and is used only to map a column name to its id for a move.
 * `count` is deliberately not declared — it can lag the set actually returned, so it must not
 * drive the board-read loop — and neither is the filter-mode array-index id, meaningless as an
 * address.
 */
export interface RawBucket {
  id: number;
  title: string;
  tasks: RawTask[] | null;
}

/** Writable task fields, as the REST API accepts them. */
export interface TaskWrite {
  title?: string;
  /** HTML — convert markdown before calling. */
  description?: string;
  done?: boolean;
  priority?: number;
  due_date?: string;
}

/**
 * The same fields in the vocabulary the tools speak: markdown rather than HTML, `due` rather
 * than the `due_date` column, and `""` for "clear this" rather than Vikunja's zero values.
 * `toTaskWrite` in `projection` is the one place that bridges the two.
 */
export interface TaskFields {
  title?: string;
  /** Markdown. `""` clears the description. */
  description?: string;
  done?: boolean;
  /** 0 is "no priority", which is also how Vikunja stores an unset one. */
  priority?: number;
  /** RFC3339 timestamp, or `""` to clear the due date. */
  due?: string;
}

/** Writable label fields, as the REST API accepts them. */
export interface LabelWrite {
  title?: string;
  /** Carried on an update to keep the fixed-column write from erasing it; no tool sets it. */
  description?: string;
  /** Six hex digits, no `#`. `""` is no colour. */
  hex_color?: string;
}

/**
 * The same fields in the vocabulary the label tools speak: `color` rather than the `hex_color`
 * column, and a colour that may be written the way a human writes one. `toLabelWrite` in
 * `projection` is the one place that bridges the two — and the one place that refuses a colour
 * Vikunja would take and silently store as something else.
 *
 * No `description`: the UI barely surfaces it, and exposing it would drag the whole
 * markdown/HTML question along. An update preserves it rather than ignoring it.
 */
export interface LabelFields {
  title?: string;
  /** Six hex digits, with or without a leading `#`. `""` clears the colour. */
  color?: string;
}
