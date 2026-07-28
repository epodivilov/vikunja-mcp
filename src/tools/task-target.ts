/**
 * How every task tool is pointed at a task: by key (`INFRA-41`), or by the global id as an
 * escape hatch. Shared so the five write tools cannot drift into five different spellings of
 * the same argument — an agent that learns the shape once should be able to use all of them.
 *
 * The comment tools address a comment the same way plus a numeric `commentId`, so that variant
 * lives here too rather than in one of the four tool files: it is the same contract, and this
 * module — zod and type-only imports, nothing else at runtime — is one of the few under `src/`
 * a test can actually load. That last property is why the comment update's body sits here as
 * well: a `.js` value import of any sibling would make this module unloadable, so everything
 * that has to be provable is kept in one file with nothing but zod behind it.
 */
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import type { Resolver } from "../resolver.js";
import type { LeanTask, RawTask, TaskWrite } from "../types.js";

export const taskTargetShape = {
  task: z
    .string()
    .optional()
    .describe(
      'Task key exactly as the UI shows it, e.g. "INFRA-41". The normal way to name a task.',
    ),
  id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Global task id. Escape hatch for a task whose project has no key; prefer `task` everywhere else.",
    ),
};

/**
 * The second task of a relation. Its own field names, because a tool naming two tasks cannot
 * spell both of them `task` — and because an error about the second one has to say which
 * argument it means.
 */
export const otherTaskTargetShape = {
  otherTask: z
    .string()
    .optional()
    .describe('The other task, by key, e.g. "INFRA-42". The normal way to name it.'),
  otherId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Global id of the other task. Escape hatch; prefer `otherTask`."),
};

export interface TaskTarget {
  task?: string | undefined;
  id?: number | undefined;
}

/** What the two target arguments are called, so a refusal names the field the caller passed. */
export interface TaskTargetNames {
  key: string;
  id: string;
}

const TASK_NAMES: TaskTargetNames = { key: "task", id: "id" };

/** The spelling `otherTaskTargetShape` uses; pass it when resolving the second task. */
export const OTHER_TASK_NAMES: TaskTargetNames = { key: "otherTask", id: "otherId" };

/**
 * The task a tool was pointed at, as the server currently has it.
 *
 * The row is returned rather than only its id because every write tool has to name the task it
 * touched, and a key cannot be reconstructed from an id without asking: Vikunja fills
 * `identifier` in on a read but not in the answer to a write. Resolving a key already reads the
 * row, so this costs an extra request only on the `{ id }` path — where it buys a plain "no such
 * task" before anything is written.
 */
export async function resolveTaskTarget(
  client: VikunjaClient,
  resolver: Resolver,
  target: TaskTarget,
  names: TaskTargetNames = TASK_NAMES,
): Promise<RawTask> {
  const key = target.task?.trim();

  if (key && target.id !== undefined) {
    throw new Error(
      `Pass either ${names.key} ("${key}") or { ${names.id}: ${target.id} }, not both — they may name different tasks.`,
    );
  }

  if (target.id !== undefined) {
    return client.getTask(target.id);
  }

  if (!key) {
    throw new Error(
      `Which task? Pass its key, e.g. { ${names.key}: "INFRA-41" }, or its global id as { ${names.id}: 123 }.`,
    );
  }

  return resolver.resolveTask(key);
}

/**
 * How a tool is pointed at *many* tasks: a list of keys, with a list of global ids as the same
 * escape hatch `taskTargetShape` offers for one. Both may be passed together, and a task named
 * twice is acted on once — see `resolveBulkTargets`.
 */
export const bulkTaskTargetShape = {
  tasks: z
    .array(z.string())
    .optional()
    .describe(
      'Task keys exactly as the UI shows them, e.g. ["INFRA-41", "INFRA-42"]. The normal way to name tasks.',
    ),
  ids: z
    .array(z.number().int().positive())
    .optional()
    .describe(
      "Global task ids. Escape hatch for tasks whose project has no key; prefer `tasks` everywhere else.",
    ),
};

export interface BulkTaskTarget {
  tasks?: readonly string[] | undefined;
  ids?: readonly number[] | undefined;
}

/**
 * Every named task, as the server currently has it: distinct, and in the order the caller named
 * them — a task named twice appears once, at its first mention.
 *
 * Keys go through `resolver.resolveTasks`, which costs one request per project rather than one
 * per key. Ids are read one at a time through `GET /tasks/{id}`, deliberately, even though
 * `filter=id in …` would batch them: the `GET /tasks` collection omits archived projects
 * entirely, so a batched id read would report a task that exists — and that the server would
 * happily write — as missing. One request per id is what an escape hatch is allowed to cost, and
 * it keeps the failure honest: an archived project's task resolves here and the *write* is then
 * refused by the server itself, with its own 412.
 *
 * Nothing here is written, and the whole set is resolved before the caller writes anything, so a
 * name that resolves to nothing leaves every task in the call untouched.
 */
export async function resolveBulkTargets(
  client: VikunjaClient,
  resolver: Resolver,
  target: BulkTaskTarget,
): Promise<RawTask[]> {
  const keys = target.tasks ?? [];
  const ids = target.ids ?? [];

  if (keys.length === 0 && ids.length === 0) {
    throw new Error(
      'Which tasks? Pass their keys as { tasks: ["INFRA-41", "INFRA-42"] }, or global ids as { ids: [123, 124] }.',
    );
  }

  const named = await resolver.resolveTasks(keys);

  for (const id of ids) {
    named.push(await client.getTask(id));
  }

  // Deduplicated by task id, not by how the caller spelled it: a key and its own id name one
  // task, and sending it twice would ask the endpoint to write the same row twice.
  const seen = new Set<number>();
  const distinct: RawTask[] = [];

  for (const task of named) {
    if (!seen.has(task.id)) {
      seen.add(task.id);
      distinct.push(task);
    }
  }

  return distinct;
}

/** One task a bulk write must not touch, and why. */
export interface BulkBlocker {
  /** The task's key, as the caller reads it. */
  ref: string;
  /** What blocks it, one phrase per field. Never empty. */
  reasons: string[];
  /** Whether the endpoint would destroy something on it: assignees, reminders, the favourite. */
  destroys: boolean;
  /** Whether it repeats, so the `done` in this patch would not stick. Only ever set with one. */
  repeats: boolean;
}

/**
 * Whether the server will treat a completion of this task as a repeat rather than as a close.
 *
 * `repeat_mode` decides which field carries the schedule: `1` is monthly and **ignores**
 * `repeat_after`, so a monthly-repeating task is `{ repeat_mode: 1, repeat_after: 0 }` and a test
 * of the interval alone would call it non-repeating. Modes `0` and `2` both use the interval.
 * The mode numbers come from `models.TaskRepeatMode` in `docs.json`, not from the prose
 * `description` beside it, which says "3 = repeats from the current date" and is a typo.
 *
 * Fails closed, like every other branch of the check: a row carrying neither field did not come
 * from a read, and "no repeat fields" must not be read as "does not repeat".
 */
function isRepeating(task: RawTask): boolean {
  if (task.repeat_mode === undefined && task.repeat_after === undefined) return true;

  return task.repeat_mode === 1 || (task.repeat_after ?? 0) > 0;
}

/**
 * The tasks of `tasks` that `POST /tasks/bulk` would damage, with the reason for each.
 *
 * Three things ignore that endpoint's `fields` list entirely, and it destroys all three
 * (`tasks.go` / `task_assignees.go` at v2.3.0, all before or outside the `fields` block):
 * `updateTaskAssignees` deletes every assignee the payload does not carry, `updateReminders`
 * deletes the reminders unconditionally and re-inserts what `values` held — nothing — and
 * `if !t.IsFavorite && wasFavorite` drops the task out of the caller's favourites. Probed on
 * 2.3.0: a task with one assignee, one reminder and `is_favorite: true`, bulk-updated on
 * `priority` alone, came back with none of the three. One `values` object serves the whole set,
 * so there is nothing to echo back per task — the only defence is not to write those tasks.
 *
 * A fourth class blocks only when the patch completes a task that is not already done: a
 * **repeating** task. Probed live on
 * 2.3.0 — the endpoint computes the rolled-forward dates, returns them in the 200 body, and then
 * persists only the columns named in `fields`, so the roll is discarded. The task is left open,
 * its due date still in the past, carrying a `done_at` stamp: a completion that silently did not
 * take, and an inconsistent row. `POST /tasks/{id}` rolls it correctly, which is why the refusal
 * points at `vikunja_complete_task`.
 *
 * That one is conditional where the other three are not, and the asymmetry is the point: the
 * first three are destroyed whichever field is written, so refusing them always is right, while
 * a repeating task takes a `priority`, a `due`, a re-open, or a `done` it already carries,
 * perfectly well. Refusing those too would be a false refusal — being stricter than the server
 * for no gain, which this project does not do.
 *
 * It fails **closed**. All the fields it reads are sent by both read paths, so a row that carries
 * none of them did not come from a read — and treating that as "clean" would fail open on exactly
 * the path this guard exists to cover.
 *
 * Pure, and taking rows rather than a client: the check is worth proving on its own, and the
 * ordering it belongs to (resolve, vet, *then* write) is proved by `applyBulkUpdate`. It takes the
 * patch as well as the rows because one of the four classes depends on what is being written.
 */
export function findBulkBlockers(tasks: readonly RawTask[], fields: BulkTaskFields): BulkBlocker[] {
  const blockers: BulkBlocker[] = [];

  for (const task of tasks) {
    const reasons: string[] = [];

    if (Array.isArray(task.assignees)) {
      if (task.assignees.length > 0) {
        // Named by field, not by prose: the caller has to know which of the three to clear.
        reasons.push(`assignees: ${task.assignees.map((user) => user.username).join(", ")}`);
      }
    } else if (task.assignees !== null) {
      reasons.push("its assignees were not reported by the read this check ran on");
    }

    if (Array.isArray(task.reminders)) {
      if (task.reminders.length > 0) {
        reasons.push(
          task.reminders.length === 1 ? "1 reminder" : `${task.reminders.length} reminders`,
        );
      }
    } else if (task.reminders !== null) {
      reasons.push("its reminders were not reported by the read this check ran on");
    }

    if (typeof task.is_favorite === "boolean") {
      if (task.is_favorite) {
        reasons.push("one of your favourites");
      }
    } else {
      reasons.push("its favourite flag was not reported by the read this check ran on");
    }

    // Everything above is destroyed whatever is written; what follows depends on the patch.
    const destroys = reasons.length > 0;

    // Only on the transition the server actually treats as a repeat: not-done -> done. Anything
    // wider is a refusal the server would not make. `updateDone` enters the repeat branch on
    // `!oldTask.Done && newTask.Done` alone, so a *re-open* of a repeating task is handled
    // honestly — probed on 2.3.0: a bulk `done: false` on an open repeating task changed nothing,
    // stamped no `done_at` and moved no date. Re-asserting `done: true` on one already done is no
    // transition either. Refusing those would also point the caller at `vikunja_complete_task`,
    // which only ever writes `done: true` — advice that writes the opposite of what was asked.
    const repeats = fields.done === true && !task.done && isRepeating(task);

    if (repeats) {
      reasons.push("repeats, so a bulk completion would not stick");
    }

    if (reasons.length > 0) {
      // The fallback is unreachable on a read: `setIdentifier` fills `identifier` in itself,
      // down to `#<index>` for a project with no prefix, so `identifier || fallback` never takes
      // it. It is kept for the one row that did NOT come from a read — precisely what the
      // fail-closed branches above report, and the only row with nothing else to call it by.
      blockers.push({ ref: task.identifier || `task ${task.id}`, reasons, destroys, repeats });
    }
  }

  return blockers;
}

/**
 * The one refusal, naming every blocked task and pointing at the tool that can change it.
 *
 * Only the failure modes actually present are explained: a caller whose set has no repeating task
 * should not have to read about repetition to find the sentence that applies to them.
 */
function describeBulkBlockers(blockers: readonly BulkBlocker[]): string {
  const named = blockers
    .map((blocker) => `${blocker.ref} (${blocker.reasons.join("; ")})`)
    .join(", ");

  const destroys = blockers.some((blocker) => blocker.destroys);
  const repeats = blockers.some((blocker) => blocker.repeats);

  const why: string[] = [];
  const remedies: string[] = [];

  if (destroys) {
    why.push(
      "it deletes a task's assignees and reminders and drops it out of your favourites no matter which fields it is told to write",
    );
    remedies.push(repeats ? "vikunja_update_task for the first three" : "vikunja_update_task");
  }

  if (repeats) {
    why.push(
      "it does not make a completion stick on a repeating task, which stays open with its dates unrolled and a done_at stamp on it",
    );
    remedies.push(
      destroys ? "vikunja_complete_task for the repeating ones" : "vikunja_complete_task",
    );
  }

  return `Nothing was written. Vikunja's bulk endpoint mishandles these tasks: ${why.join(", and ")}. The tasks are: ${named}. Change them one at a time with ${remedies.join(", or ")}, or leave them out of this call.`;
}

/** The fields a bulk update may set — the three that mean something set identically on a set. */
export interface BulkTaskFields {
  done?: boolean | undefined;
  priority?: number | undefined;
  due?: string | undefined;
}

/**
 * The whole body of `vikunja_bulk_update_tasks`: refuse an empty patch, resolve every named task,
 * refuse the set if any of them would be damaged, write once, read back.
 *
 * The order is the substance, and it is why this lives here rather than in the tool file: a test
 * can load this module (zod is its only runtime import) and cannot load a tool. Resolution before
 * the write is what makes a bad name change nothing; the blocker check before the write is what
 * keeps a task's assignees and reminders; the read-back afterwards is what makes the answer the
 * server's own state rather than an echo of the request.
 *
 * That last one earns more than it looks. Probed on 2.3.0 with a repeating task: the 200 body
 * carried a rolled-forward `due_date` that the server then did not persist, so echoing it would
 * have reported a date that is not in the database. Reading back reports what is stored. The
 * blocker check now refuses that case outright, so it is no longer reachable here — but the
 * reason for reading back rather than echoing stands on its own.
 *
 * `fields` is turned into the endpoint's `fields` list by taking the *patch's own keys*, so a
 * cleared priority (`0`) and a cleared due date (`""`) are written rather than restored from the
 * stored row, and nothing the caller did not ask for is ever named.
 *
 * `toTaskWrite` and `toLeanTask` are parameters rather than imports for the reason
 * `applyCommentUpdate` takes `toHtml`: a `.js` value import of `../projection.js` would make this
 * module unloadable and take every test touching it down with it. They are required, so they
 * cannot go missing by accident.
 */
export async function applyBulkUpdate(
  client: VikunjaClient,
  resolver: Resolver,
  target: BulkTaskTarget,
  fields: BulkTaskFields,
  toTaskWrite: (fields: BulkTaskFields) => TaskWrite,
  toLeanTask: (task: RawTask) => LeanTask,
): Promise<LeanTask[]> {
  const values = toTaskWrite(fields);
  const columns = Object.keys(values);

  // Refused before anything is resolved: a patch with no fields would still cost a read, and an
  // empty field list is the one thing this endpoint answers by stripping every task in the set.
  if (columns.length === 0) {
    throw new Error("Nothing to update: pass at least one of done, priority, due.");
  }

  const tasks = await resolveBulkTargets(client, resolver, target);
  const blockers = findBulkBlockers(tasks, fields);

  if (blockers.length > 0) {
    throw new Error(describeBulkBlockers(blockers));
  }

  await client.bulkUpdateTasks(
    tasks.map((task) => task.id),
    columns,
    values,
  );

  // Read back rather than project what was sent. The 200 body is the request struct rendered
  // back — its tasks never went through `setIdentifier`, so they carry no key at all — and the
  // server does not always apply a `done` as asked.
  return (await resolveBulkTargets(client, resolver, target)).map(toLeanTask);
}

/**
 * The task-addressing arguments plus the comment's own id. A comment has no per-task sequence
 * and therefore no key: the URL takes the task and the numeric id together, and the server
 * refuses the pair when the comment belongs to a different task.
 */
export const commentTargetShape = {
  ...taskTargetShape,
  commentId: z
    .number()
    .int()
    .positive()
    .describe(
      "The comment's numeric id, as the `id` of a vikunja_list_comments row. Comments have no key of their own.",
    ),
};

export interface CommentTarget extends TaskTarget {
  commentId?: number | undefined;
}

/**
 * The task a comment tool was pointed at, plus the comment id to act on.
 *
 * `commentId` is checked first, and against the caller's own argument rather than anything read
 * back, so a call that cannot name a comment fails before a single request goes out — including
 * the one `resolveTaskTarget` would issue on the `{ id }` path. The check duplicates what the
 * zod schema already promises for the same reason `buildTaskFilter` re-checks its inputs: over
 * MCP these values arrive as parsed JSON, and every tool here is one call away from a delete.
 */
export async function resolveCommentTarget(
  client: VikunjaClient,
  resolver: Resolver,
  target: CommentTarget,
): Promise<{ task: RawTask; commentId: number }> {
  const { commentId } = target;

  if (commentId === undefined) {
    throw new Error(
      "Which comment? Pass its numeric id as { commentId: 91 } — the `id` of a vikunja_list_comments row.",
    );
  }

  if (typeof commentId !== "number" || !Number.isSafeInteger(commentId) || commentId <= 0) {
    throw new Error(`Comment id must be a positive integer, got ${JSON.stringify(commentId)}.`);
  }

  return { task: await resolveTaskTarget(client, resolver, target), commentId };
}

/** What `applyCommentUpdate` answers with: the comment's id and the task carrying it. */
export interface UpdatedComment {
  ref: string;
  commentId: number;
}

/**
 * The whole body of `vikunja_update_comment`: resolve the target, convert the markdown, replace
 * the stored body, name the task it lives on.
 *
 * It lives here rather than inside the tool file for the reason `resolveCommentTarget` does — a
 * tool file cannot be loaded under `node --test`, so logic left in one is logic nothing can
 * prove. The conversion is the piece worth proving: Vikunja stores a comment body verbatim, so
 * an update that forgets it publishes literal `**asterisks**` to the UI and no test would
 * notice.
 *
 * `toHtml` is a parameter instead of an import because importing `../projection.js` here at
 * runtime would make this module unresolvable to the type-stripping loader and take every test
 * that touches it down with it. `update-comment.ts` passes the real `markdownToHtml`; that one
 * binding is the only part of the update path still unpinned, and it is a required argument
 * rather than an omittable call, so it cannot go missing by accident.
 */
export async function applyCommentUpdate(
  client: VikunjaClient,
  resolver: Resolver,
  target: CommentTarget,
  markdown: string,
  toHtml: (markdown: string) => string,
): Promise<UpdatedComment> {
  const { task, commentId } = await resolveCommentTarget(client, resolver, target);

  await client.updateComment(task.id, commentId, toHtml(markdown));

  // The task's key names where the comment lives, which its id alone cannot say. Read straight
  // off the task — this is the field `toLeanTask` maps to `ref`, and the task came from a read,
  // where Vikunja always fills `identifier` in.
  return { ref: task.identifier, commentId };
}
