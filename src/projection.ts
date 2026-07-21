/**
 * Raw Vikunja objects -> lean DTOs, plus the markdown <-> HTML conversion that
 * Vikunja itself does not perform. Nothing here talks to the network; every
 * function is pure so the mapping can be reasoned about on its own.
 */
import { marked } from "marked";
import TurndownService from "turndown";
import type { LeanLabel, LeanProject, LeanTask, LeanTaskDetail } from "./types.js";

/** Vikunja's zero value for an unset timestamp. */
const ZERO_DATE = "0001-01-01T00:00:00Z";

/** Matches any HTML element tag; see `htmlToMarkdown` for why we sniff. */
const HTML_TAG = /<\/?[a-z][^>]*>/i;

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

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

/**
 * Markdown -> HTML, for every description and comment we write. Vikunja stores
 * the string verbatim, so whatever this returns is exactly what the UI renders.
 */
export function markdownToHtml(markdown: string): string {
  if (!markdown.trim()) {
    return "";
  }

  return marked.parse(markdown, { async: false }).trim();
}

/**
 * HTML -> markdown, for every description we hand to the model.
 *
 * Input that carries no tag is passed through untouched: descriptions written
 * by older clients are stored as raw markdown, and turndown would escape them
 * into `\*\*bold\*\*` while collapsing the line breaks.
 */
export function htmlToMarkdown(html: string): string {
  if (!html.trim() || !HTML_TAG.test(html)) {
    return html.trim();
  }

  return turndown.turndown(html).trim();
}
