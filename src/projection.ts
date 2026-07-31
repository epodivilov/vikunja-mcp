/**
 * Raw Vikunja objects -> lean DTOs, plus the markdown <-> HTML conversion that
 * Vikunja itself does not perform. Nothing here talks to the network; every
 * function is pure so the mapping can be reasoned about on its own.
 */
import { Renderer, marked } from "marked";
import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";
import type {
  BoardMode,
  LabelFields,
  LabelWrite,
  LeanBoard,
  LeanColumn,
  LeanComment,
  LeanLabel,
  LeanProject,
  LeanRelation,
  LeanTask,
  LeanTaskDetail,
  LeanUser,
  RawBucket,
  RawComment,
  RawLabel,
  RawProject,
  RawTask,
  RawUser,
  TaskFields,
  TaskRefLookup,
  TaskWrite,
} from "./types.ts";

/** Vikunja's zero value for an unset timestamp. */
const ZERO_DATE = "0001-01-01T00:00:00Z";

/**
 * Tags the Vikunja editor actually emits. The sniff in `htmlToMarkdown` is an
 * allowlist rather than "any `<word>`" because markdown autolinks
 * (`<https://example.com>`, `<ev@example.com>`) look like tags to a loose
 * pattern, and routing those through turndown deletes the URL outright.
 */
const HTML_TAGS =
  "p|div|span|br|hr|ul|ol|li|h[1-6]|strong|b|em|i|s|del|a|code|pre|blockquote|" +
  "table|thead|tbody|tfoot|tr|th|td|img|input|label";

const HTML_TAG = new RegExp(`</?(?:${HTML_TAGS})(?:\\s[^>]*)?/?>`, "i");

/**
 * The DOM surface turndown hands to a rule. Declared locally because the
 * project compiles without the DOM lib — these are domino nodes, not browser
 * ones, and only these members are touched.
 */
interface DomNode {
  nodeName: string;
  parentNode: DomNode | null;
  childNodes: ArrayLike<DomNode>;
  getAttribute(name: string): string | null;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

turndown.use(tables);

/**
 * The editor wraps every table cell's content in a `<p>`, which makes the cell
 * block-level and injects newlines into the row — enough to break the markdown
 * table outright. Render those paragraphs inline instead.
 */
turndown.addRule("tableCellParagraph", {
  filter: (node) => node.nodeName === "P" && isInsideTableCell(node as unknown as DomNode),
  replacement: (content) => content.trim(),
});

/**
 * Checkbox state is task-manager data, so losing it is not cosmetic. The GFM
 * plugin's own rule only matches `<li><input>`, while the editor emits
 * `<li><label><input></label><div><p>text</p></div></li>` — both shapes here.
 */
turndown.addRule("taskListItem", {
  filter: (node) => findCheckbox(node as unknown as DomNode) !== null,
  replacement: (content, node) => {
    const item = node as unknown as DomNode;
    const checked =
      item.getAttribute("data-checked") === "true" ||
      findCheckbox(item)?.getAttribute("checked") != null;

    return `- [${checked ? "x" : " "}] ${content.trim()}\n`;
  },
});

/** Walks up to a `<td>`/`<th>`, so nested markup in a cell is caught too. */
function isInsideTableCell(node: DomNode): boolean {
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    if (parent.nodeName === "TD" || parent.nodeName === "TH") {
      return true;
    }
  }

  return false;
}

/**
 * The checkbox belonging to `node` itself, or null. Only direct children and
 * `<label>` wrappers are searched: a descendant lookup would also match a
 * checkbox from a nested sub-list and turn its parent into a task item.
 */
function findCheckbox(node: DomNode): DomNode | null {
  if (node.nodeName !== "LI") {
    return null;
  }

  for (const child of Array.from(node.childNodes)) {
    if (isCheckbox(child)) {
      return child;
    }

    if (child.nodeName === "LABEL") {
      const nested = Array.from(child.childNodes).find(isCheckbox);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

function isCheckbox(node: DomNode): boolean {
  return node.nodeName === "INPUT" && node.getAttribute("type") === "checkbox";
}

/** Drops Vikunja's zero timestamp so an unset date is absent rather than year 1. */
export function nullableDate(raw: string): string | undefined {
  return !raw || raw === ZERO_DATE ? undefined : raw;
}

/** Six hex digits, with an optional leading `#` — the only colour Vikunja can actually render. */
const HEX_COLOR = /^#?[0-9a-f]{6}$/i;

/**
 * A stored colour in the one form this server reports: no `#`, lower-case, trimmed. Applied on
 * the way out as well as on the way in, because the server stores whatever case it was handed
 * and most of a real instance's labels are upper-case.
 *
 * Deliberately does not validate: a colour already stored is reported as it is, not refused. The
 * validation belongs on the write, where refusing still changes the outcome.
 */
function normaliseHex(raw: string): string {
  return raw.trim().replace(/^#/, "").toLowerCase();
}

/**
 * A colour as the tools accept one -> the value Vikunja stores, or an error naming the form.
 *
 * Six hex digits is stricter than the server, on purpose, and the two gaps it closes both lose
 * data silently. `hex_color` is validated as `runelength(0|7)` and then run through `NormalizeHex`
 * (v2.3.0 `pkg/utils`), which strips a leading `#` **and truncates to six characters**: `ff00001`
 * passes the length check and is stored as `ff0000`, a colour the caller never asked for. And
 * `red` passes it too, storing a value nothing can render. Neither is reported as an error, so
 * neither can be noticed from the outside.
 */
export function parseHexColor(input: string): string {
  const color = input.trim();

  if (!HEX_COLOR.test(color)) {
    throw new Error(
      `"${input}" is not a colour Vikunja can store. Use six hex digits, with or without a leading "#" — "#0ea5e9" or "0ea5e9". Pass "" to leave a label with no colour.`,
    );
  }

  return normaliseHex(color);
}

/**
 * Label fields -> the columns the API writes, the mirror of `toLeanLabel`. Only the fields present
 * are mapped: an omitted one means "leave it alone", and `client.updateLabel` is what supplies the
 * stored value in its place — `POST /labels/{id}` zeroes every column its payload omits.
 *
 * Clearing therefore has to be spelled, as it does for a task's description: `color: ""` becomes
 * an explicit empty `hex_color` rather than an absent key.
 */
export function toLabelWrite(fields: LabelFields): LabelWrite {
  const write: LabelWrite = {};

  if (fields.title !== undefined) {
    write.title = fields.title;
  }
  if (fields.color !== undefined) {
    write.hex_color = fields.color.trim() === "" ? "" : parseHexColor(fields.color);
  }

  return write;
}

/**
 * A label, stripped to what an agent can act on. Field by field rather than by spread, like
 * `toLeanUser`: the raw label carries a `created_by` user object and a description, and a spread
 * would hand both to the model.
 */
export function toLeanLabel(raw: RawLabel): LeanLabel {
  const label: LeanLabel = { id: raw.id, title: raw.title };
  const color = normaliseHex(raw.hex_color);

  // `""` is how Vikunja stores "no colour"; absent says the same thing for free.
  if (color !== "") {
    label.color = color;
  }

  return label;
}

/**
 * A user, stripped to what an agent can act on: the username it addresses one by, the id that
 * disambiguates a shared spelling, and a display name when there is one.
 *
 * Field by field rather than by spread, deliberately. The raw object carries an email — blank on
 * the members listing, populated elsewhere — and a spread would hand it to the model the moment
 * this function is reused on a payload where the server fills it in.
 */
export function toLeanUser(raw: RawUser): LeanUser {
  const user: LeanUser = { id: raw.id, username: raw.username };

  // `""` is how Vikunja stores "no display name"; it is noise in an answer, not information.
  if (raw.name.trim() !== "") {
    user.name = raw.name;
  }

  return user;
}

/**
 * One comment -> the four fields an agent can use. The body goes through the same
 * `htmlToMarkdown` a description does, since comments are stored the same way: verbatim HTML
 * from the editor, or raw markdown when an older client wrote them.
 *
 * The author collapses to a username. Vikunja expands it to the whole user record — name, email,
 * avatar provider, its own timestamps — and none of that is anyone's business here; a comment
 * with no resolvable author (deleted user, link share) simply has no `author` field rather than
 * an empty string. `created` is passed through untouched: unlike a due date it is always a real
 * timestamp, so `nullableDate` has nothing to do to it.
 */
export function toLeanComment(raw: RawComment): LeanComment {
  const comment: LeanComment = {
    id: raw.id,
    comment: htmlToMarkdown(raw.comment),
    created: raw.created,
  };

  const username = raw.author?.username;
  if (username) {
    comment.author = username;
  }

  return comment;
}

export function toLeanProject(raw: RawProject): LeanProject {
  const project: LeanProject = { key: raw.identifier, id: raw.id, title: raw.title };

  // Set only when true, like every other optional field here: a listing of live projects stays
  // exactly as lean as it was, and the flag shows up only where it changes what a caller can
  // expect of the project's tasks.
  if (raw.is_archived) {
    project.archived = true;
  }

  return project;
}

export function toLeanTask(raw: RawTask): LeanTask {
  const task: LeanTask = {
    ref: raw.identifier,
    id: raw.id,
    title: raw.title,
    done: raw.done,
    labels: (raw.labels ?? []).map((label) => label.title),
  };

  if (raw.priority > 0) {
    task.priority = raw.priority;
  }

  const due = nullableDate(raw.due_date);
  if (due) {
    task.due = due;
  }

  // Absent rather than empty, like every other optional field here: most tasks have no assignee,
  // and `"assignees":[]` on every row of a listing is a cost with no information in it.
  const assignees = (raw.assignees ?? []).map((user) => user.username);
  if (assignees.length > 0) {
    task.assignees = assignees;
  }

  return task;
}

/**
 * One raw bucket -> a lean column: the bucket's title becomes the column name, its embedded
 * tasks become lean rows. The bucket id — a DB PK on a manual board, a meaningless array index
 * on a filter one — is dropped, so it never reaches the model. A bucket read from the plain
 * buckets listing (`tasks: null`) projects to an empty column.
 */
export function toLeanColumn(raw: RawBucket): LeanColumn {
  return { name: raw.title, tasks: (raw.tasks ?? []).map(toLeanTask) };
}

/** A whole board: the mode, plus every bucket projected to a column in the server's order. */
export function toLeanBoard(mode: BoardMode, buckets: readonly RawBucket[]): LeanBoard {
  return { mode, columns: buckets.map(toLeanColumn) };
}

/**
 * Lean fields -> the columns the API writes. The mirror of `toLeanTask`, closing the same
 * vocabulary gap in the other direction: `due` is stored as `due_date`, markdown is stored as
 * HTML, and "no value" is a zero value rather than a null Vikunja would reject.
 *
 * Only the fields actually present are mapped. That matters upstream: `POST /tasks/{id}`
 * re-zeroes every column its payload omits, so a patch has to say exactly what it means to
 * change and nothing more — `client.updateTask` layers it onto the task as the server has it.
 *
 * Clearing therefore has to be spelled, since an omitted field means "leave alone": `""` clears
 * a description, and `""` for a due date becomes Vikunja's own zero timestamp, which is what
 * an unset date reads back as.
 */
export function toTaskWrite(fields: TaskFields): TaskWrite {
  const write: TaskWrite = {};

  if (fields.title !== undefined) {
    write.title = fields.title;
  }
  if (fields.description !== undefined) {
    write.description = markdownToHtml(fields.description);
  }
  if (fields.done !== undefined) {
    write.done = fields.done;
  }
  if (fields.priority !== undefined) {
    write.priority = fields.priority;
  }
  if (fields.due !== undefined) {
    write.due_date = fields.due === "" ? ZERO_DATE : fields.due;
  }

  return write;
}

/**
 * The projects a task's related tasks live in — the identifiers a caller has to look up before
 * those tasks can be named by key. Distinct ids, in no particular order; empty when the task has
 * no relations, which is the signal that no project listing is needed at all.
 *
 * Separate from the projection below because the lookup it feeds is asynchronous and this module
 * is not: the caller resolves these, then hands the answer back in as `refOf`.
 */
export function relatedProjectIds(raw: RawTask): number[] {
  const ids = new Set<number>();

  for (const related of Object.values(raw.related_tasks ?? {})) {
    for (const task of related ?? []) {
      ids.add(task.project_id);
    }
  }

  return [...ids];
}

/**
 * `related_tasks` -> one flat list of lean relations, each carrying the kind it was filed under.
 *
 * The ref is rebuilt through `refOf` rather than read from the related task's own `identifier`:
 * the server leaves that empty on every embedded row, and a related task may well sit in another
 * project — including an archived one — whose prefix only the resolver knows.
 *
 * Null, `{}` and an absent field all mean "no relations", and so does a kind whose array is
 * empty; each is a shape Vikunja actually sends.
 */
export function toLeanRelations(raw: RawTask, refOf: TaskRefLookup): LeanRelation[] {
  const relations: LeanRelation[] = [];

  for (const [kind, related] of Object.entries(raw.related_tasks ?? {})) {
    for (const task of related ?? []) {
      relations.push({
        kind,
        ref: refOf(task.project_id, task.index),
        title: task.title,
        done: task.done,
      });
    }
  }

  return relations;
}

/**
 * One task in full. `refOf` is required rather than optional so that a caller cannot drop a
 * task's relations by forgetting an argument — the omission would be silent, and "this task
 * blocks nothing" is a claim worth being unable to make by accident.
 */
export function toLeanTaskDetail(raw: RawTask, refOf: TaskRefLookup): LeanTaskDetail {
  const detail: LeanTaskDetail = toLeanTask(raw);
  const description = htmlToMarkdown(raw.description);

  if (description) {
    detail.description = description;
  }

  const relations = toLeanRelations(raw, refOf);
  if (relations.length > 0) {
    detail.relations = relations;
  }

  return detail;
}

/** Schemes a link may carry. Anything else loses its anchor and keeps its text. */
const SAFE_HREF = /^(?:https?:|mailto:|#|\/)/i;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Vikunja stores descriptions verbatim and sanitizes nothing, so this renderer
 * is the only thing standing between a description and the browser rendering
 * it. Markdown goes in, only markdown-derived HTML comes out: raw tags are
 * escaped to text rather than passed through, because the markdown here is
 * written by a model that has just read text from tasks it does not own.
 */
const renderer = new Renderer();

renderer.html = ({ text }) => escapeHtml(text);

renderer.link = function link({ href, title, tokens }) {
  const text = this.parser.parseInline(tokens);

  if (!SAFE_HREF.test(href)) {
    return text;
  }

  return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ""}>${text}</a>`;
};

renderer.image = function image({ href, title, text }) {
  if (!SAFE_HREF.test(href)) {
    return escapeHtml(text);
  }

  return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${
    title ? ` title="${escapeHtml(title)}"` : ""
  }>`;
};

/**
 * Markdown -> HTML, for every description and comment we write. Vikunja stores
 * the string verbatim, so whatever this returns is exactly what the UI renders.
 */
export function markdownToHtml(markdown: string): string {
  if (!markdown.trim()) {
    return "";
  }

  return marked.parse(markdown, { async: false, renderer }).trim();
}

/**
 * HTML -> markdown, for every description we hand to the model.
 *
 * Input carrying none of `HTML_TAGS` is passed through untouched: descriptions
 * written by older clients are stored as raw markdown, and turndown would
 * escape them into `\*\*bold\*\*` while collapsing the line breaks.
 */
export function htmlToMarkdown(html: string): string {
  if (!html.trim() || !HTML_TAG.test(html)) {
    return html.trim();
  }

  return turndown.turndown(html).trim();
}
