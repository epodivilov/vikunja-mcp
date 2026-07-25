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
import type { RawTask } from "../types.js";

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
