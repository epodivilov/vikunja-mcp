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
}

export interface RawComment {
  id: number;
  /** HTML, like task descriptions. */
  comment: string;
  created: string;
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
