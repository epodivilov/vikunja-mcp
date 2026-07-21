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

export interface TaskTarget {
  task?: string | undefined;
  id?: number | undefined;
}

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
): Promise<RawTask> {
  const key = target.task?.trim();

  if (key && target.id !== undefined) {
    throw new Error(
      `Pass either the key ("${key}") or { id: ${target.id} }, not both — they may name different tasks.`,
    );
  }

  if (target.id !== undefined) {
    return client.getTask(target.id);
  }

  if (!key) {
    throw new Error(
      'Which task? Pass its key, e.g. { task: "INFRA-41" }, or its global id as { id: 123 }.',
    );
  }

  return resolver.resolveTask(key);
}
