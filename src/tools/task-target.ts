/**
 * How every task tool is pointed at a task: by key (`INFRA-41`), or by the global id as an
 * escape hatch. Shared so the five write tools cannot drift into five different spellings of
 * the same argument — an agent that learns the shape once should be able to use all of them.
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
