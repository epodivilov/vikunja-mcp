/**
 * The three label tools, minus their schemas: the shared arguments, the two refusals that need no
 * server at all, and the whole body of each tool.
 *
 * It exists for the same mechanical reason `task-target.ts` does: zod plus type-only imports is
 * the one shape under `src/tools/` a `node --test` suite can load, because the type-stripping
 * loader will not resolve a `.js` value specifier to a `.ts` file. Anything worth proving is kept
 * here; what stays in a tool file — the schema, the annotations, the one call — is unproved by
 * construction, so as little as possible stays there.
 *
 * That is why the three `apply*` functions below live here rather than inside the tool files.
 * Composition is exactly what is worth proving: each of them is a refusal, a resolve and a write
 * in an order that matters, and a tool file is a place where dropping the refusal is invisible to
 * every test. `update-comment.ts` set the precedent — it hands `markdownToHtml` in as a parameter
 * so its body can live in a module a test can load — and `projection` arrives here the same way,
 * as a required argument that cannot go missing by accident.
 */
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import type { LabelRef, Resolver } from "../resolver.js";
import type { LabelFields, LabelWrite, LeanLabel, RawLabel } from "../types.js";

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

/**
 * The two projection functions a label write needs, handed in rather than imported.
 *
 * A `.js` value import of `../projection.js` would make this module unresolvable to the
 * type-stripping loader and take every test that touches it down with it — the same constraint
 * that put `applyCommentUpdate`'s `toHtml` in its parameter list. Required, not optional: a
 * projection that could be omitted is one that can go missing, and `toLabelWrite` is where a
 * colour is validated and a clear is spelled.
 */
export interface LabelProjection {
  toLabelWrite(fields: LabelFields): LabelWrite;
  toLeanLabel(raw: RawLabel): LeanLabel;
}

/** What `vikunja_delete_label` answers with. `detachedFrom` is observed, not promised — see below. */
export interface DeletedLabel {
  deleted: true;
  id: number;
  title: string;
  detachedFrom: number;
}

/**
 * The whole body of `vikunja_create_label`: refuse a title no tool could name the label by, refuse
 * one another label already holds, then create.
 *
 * The refusal comes first and the order is the point — the server accepts both titles with a 201,
 * so anything that ran the write first would have created the very label it meant to prevent.
 *
 * The create response is the label as stored, with the colour normalized server-side, so there is
 * nothing here a read-back would correct.
 */
export async function applyLabelCreate(
  client: VikunjaClient,
  resolver: Resolver,
  projection: LabelProjection,
  fields: { title: string; color?: string | undefined },
): Promise<LeanLabel> {
  await resolver.checkLabelTitleAvailable(fields.title);

  const created = await client.createLabel(projection.toLabelWrite(fields));

  return projection.toLeanLabel(created);
}

/**
 * The whole body of `vikunja_update_label`: refuse a patch that names nothing, resolve the label
 * and the new title's availability against one listing, then merge the patch onto the stored
 * record.
 *
 * `fields.title` is passed to `resolveLabel` deliberately, and it is the whole of the rename
 * refusal: without it the resolve still succeeds and the write still lands, on a title another
 * label already holds.
 */
export async function applyLabelUpdate(
  client: VikunjaClient,
  resolver: Resolver,
  projection: LabelProjection,
  label: LabelRef,
  fields: LabelFields,
): Promise<LeanLabel> {
  checkLabelPatch(fields);

  const current = await resolver.resolveLabel(label, fields.title);
  const updated = await client.updateLabel(current, projection.toLabelWrite(fields));

  return projection.toLeanLabel(updated);
}

/**
 * The whole body of `vikunja_delete_label`: resolve the label, count what carries it, guard, then
 * delete and report what the delete cost.
 *
 * No projection: the answer is not a label, it is what happened to one — and the label has to be
 * read before the delete, because afterwards there is nothing left to name it with.
 *
 * The count costs a full task listing, which exhausts pagination and parses every matching row.
 * That is the trade: nothing here is projected to the model — only the number leaves this
 * function — and it buys the guard on a rare, irreversible call. `x-pagination-result-count` is
 * the cheap-looking shortcut and it is wrong: it reports the rows in the page just returned, so at
 * `per_page=1` a label on 142 tasks would be guarded as "1 task".
 *
 * `detachedFrom` is worded as what the caller observes, not as a claim about the database: the
 * `label_tasks` rows survive the delete, and the tasks simply stop reporting a label the read can
 * no longer join.
 */
export async function applyLabelDelete(
  client: VikunjaClient,
  resolver: Resolver,
  label: LabelRef,
  force: boolean,
): Promise<DeletedLabel> {
  const target = await resolver.resolveLabel(label);
  const carrying = await client.listTasks({ labelId: target.id });

  checkLabelDeletable(target, carrying.length, force);

  await client.deleteLabel(target.id);

  return { deleted: true, id: target.id, title: target.title, detachedFrom: carrying.length };
}
