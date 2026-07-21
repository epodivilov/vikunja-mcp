/**
 * Raw Vikunja objects -> lean DTOs, plus the markdown <-> HTML conversion that
 * Vikunja itself does not perform. Nothing here talks to the network; every
 * function is pure so the mapping can be reasoned about on its own.
 */
import { Renderer, marked } from "marked";
import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";
import type { LeanLabel, LeanProject, LeanTask, LeanTaskDetail } from "./types.js";

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

/*
 * Raw input shapes. Deliberately partial: only the fields we read are declared,
 * so a new field upstream cannot break the build. `client.ts` reuses these as
 * its return types.
 */

export interface RawLabel {
  id: number;
  title: string;
}

export interface RawProject {
  id: number;
  title: string;
  identifier: string;
}

export interface RawTask {
  id: number;
  /** Server-composed key, e.g. "INFRA-41", or "#41" when the project has no identifier. */
  identifier: string;
  title: string;
  description: string;
  done: boolean;
  /** 0 means "unset"; the real scale is 1..5. */
  priority: number;
  due_date: string;
  labels: RawLabel[] | null;
}

/** Drops Vikunja's zero timestamp so an unset date is absent rather than year 1. */
export function nullableDate(raw: string): string | undefined {
  return !raw || raw === ZERO_DATE ? undefined : raw;
}

export function toLeanLabel(raw: RawLabel): LeanLabel {
  return { id: raw.id, title: raw.title };
}

export function toLeanProject(raw: RawProject): LeanProject {
  return { key: raw.identifier, id: raw.id, title: raw.title };
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

  return task;
}

export function toLeanTaskDetail(raw: RawTask): LeanTaskDetail {
  const detail: LeanTaskDetail = toLeanTask(raw);
  const description = htmlToMarkdown(raw.description);

  if (description) {
    detail.description = description;
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
