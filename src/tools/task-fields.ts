/**
 * Writable task fields that need more than a bare type, shared by the create and update
 * schemas. Validation lives in the schema so a bad value is refused before a request is built.
 */
import { z } from "zod";

/**
 * RFC3339, which is the only thing Vikunja parses. A bare `2026-07-25` is refused by the server
 * with `Invalid model provided: Bad Request` (code 2004) — probed on 2.3.0 — which tells an
 * agent nothing about which field it got wrong. Refusing it here with the format spelled out
 * costs one round trip instead of a guess. Nothing is normalized on the way through: expanding
 * a date to midnight would have to pick a timezone, and picking one silently moves the due date
 * by a day for anybody east or west of it.
 */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const DUE_FORMAT =
  'A due date has to be an RFC3339 timestamp, e.g. "2026-07-25T09:00:00Z". Vikunja rejects a bare date.';

export const dueField = z.string().regex(RFC3339, DUE_FORMAT);

/**
 * The same timestamp, plus `""` for "clear the due date".
 *
 * A clear has to be spelled out because there is nothing else to send: an omitted field means
 * "leave it alone" (the update is a patch), and Vikunja has no null for a date — an unset one
 * is the zero timestamp, which `toTaskWrite` writes. `priority: 0` already resets a priority,
 * so a date with no way back off the task would be the odd one out.
 *
 * One regex rather than a union of two, so a wrong value is answered with one message naming
 * both spellings instead of a list of branch failures.
 */
export const clearableDueField = z
  .string()
  .regex(
    new RegExp(`^$|${RFC3339.source}`),
    `${DUE_FORMAT} Pass an empty string to clear the date.`,
  );

/** Vikunja's own scale. 0 is "no priority", which is also how a task starts out. */
export const priorityField = z.number().int().min(0).max(5);
