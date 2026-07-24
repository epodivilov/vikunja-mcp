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
 * A single task read in full. Only `vikunja_get_task` returns this shape —
 * list operations stay on `LeanTask` so a listing never carries descriptions.
 */
export interface LeanTaskDetail extends LeanTask {
  /** Markdown, converted from the HTML Vikunja stores. Omitted when empty. */
  description?: string;
}

export interface LeanLabel {
  id: number;
  title: string;
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

export interface RawLabel {
  id: number;
  title: string;
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
}

export interface RawComment {
  id: number;
  /** HTML, like task descriptions. */
  comment: string;
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
