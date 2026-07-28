/**
 * The arguments the three label tools share, and the two refusals that need no server at all.
 *
 * It exists for the same mechanical reason `task-target.ts` does: zod plus type-only imports is
 * the one shape under `src/tools/` a `node --test` suite can load, because the type-stripping
 * loader will not resolve a `.js` value specifier to a `.ts` file. Anything worth proving is kept
 * here; what stays in a tool file — the schema, the annotations, the one call — is unproved by
 * construction, so as little as possible stays there.
 */
import { z } from "zod";
import type { LabelFields, RawLabel } from "../types.js";

/**
 * A label as an agent names it: the title it read in a listing, or the id printed beside it.
 *
 * `label-task.ts` and `set-task-labels.ts` each declare this union privately; the new tools use
 * this copy, and rewiring those two is deliberately left alone — it would touch two shipped tools
 * for no behaviour change.
 */
export const labelRef = z.union([z.string(), z.number().int().positive()]);

/** How the three tools point at an existing label. */
export const labelTargetShape = {
  label: labelRef.describe(
    'The label, by title as vikunja_list_labels reports it (e.g. "bug") or by its numeric id. Pass the id when a title turns out to be shared by several labels.',
  ),
};

/** A new or replacement title. Trimmed by the schema; the resolver refuses a blank one anyway. */
export const labelTitleField = z.string().trim().min(1);

/**
 * A colour, as a human writes one. Validated for real in `projection.parseHexColor` — the schema
 * cannot do it, because `""` has to reach the tool as "clear this" rather than be rejected as too
 * short.
 */
export const labelColorField = z.string();

/**
 * Refuses an update that names nothing to change.
 *
 * Such a call is not harmless: it would send the stored record back to a fixed-column write and
 * report success for a change nobody made. Checked on the caller's own arguments, so it costs no
 * request — the label is never even looked up.
 */
export function checkLabelPatch(fields: LabelFields): void {
  if (fields.title === undefined && fields.color === undefined) {
    throw new Error(
      'Nothing to change: pass a title, a colour, or both. To clear a label\'s colour pass { color: "" }.',
    );
  }
}

/**
 * The delete guard: whether a label may go, given how many tasks carry it and whether the caller
 * said `force`.
 *
 * Deleting a label takes it off every task that carries it, immediately and with no undo —
 * Vikunja warns about none of that and answers a plain 200. So a label in use is refused unless
 * the caller has said, in this call, that it means it.
 *
 * The count is a floor and the message says so: `GET /tasks` builds its collection from
 * non-archived projects and offers no way to widen it, so a label used only inside an archived
 * project is invisible to the count that guards it.
 */
export function checkLabelDeletable(label: RawLabel, taskCount: number, force: boolean): void {
  if (taskCount === 0 || force) {
    return;
  }

  throw new Error(
    `"${label.title}" (id ${label.id}) is on ${taskCount} task${taskCount === 1 ? "" : "s"}, and deleting a label takes it off every one of them — Vikunja has no undo for that. Pass { force: true } to delete it anyway, or use vikunja_set_task_labels to take it off those tasks first. Tasks in archived projects are not counted, so the real number may be higher.`,
  );
}
