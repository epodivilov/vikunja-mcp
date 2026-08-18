/**
 * `vikunja_update_tasks` — update many tasks in one call, each with its OWN patch.
 *
 * A heterogeneous batch: every item names a task and lists the fields to change on it, and the
 * fields may differ from item to item. That is the whole reason this is not `vikunja_bulk_update_
 * tasks`, which can only broadcast one identical `values` object across ids — and, doing so,
 * destroys assignees, reminders and favourites and mishandles a repeating completion. This tool is a
 * plain read-modify-write loop over `update_task`'s path (`applyTaskUpdates`), safe exactly where
 * the native endpoint is not, at the cost of one write per task rather than one transaction.
 *
 * The body lives in `applyTaskUpdates` in a module the test suite can load; this file is the schema,
 * the annotations and one call. The per-item schema is exported so a test can drive the strict
 * refusal of `labels`/`assignees` through the exact object the tool registers, not a copy of it.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.ts";
import { toLeanTask, toTaskWrite } from "../projection.ts";
import type { Resolver } from "../resolver.ts";
import { jsonResult } from "./result.ts";
import { clearableDueField, priorityField } from "./task-fields.ts";
import { applyTaskUpdates, taskTargetShape } from "./task-target.ts";

/**
 * One task's update: how it is addressed, plus the fields to change. Strict, so a field this tool
 * does not implement — `labels`, `assignees` — is refused per item rather than silently dropped,
 * exactly as `vikunja_update_task` refuses them. The field vocabulary is `update_task`'s verbatim:
 * `priorityField` and `clearableDueField`, where `""` clears the due date and a `""` description
 * clears the body.
 */
export const updateItemSchema = z.strictObject({
  ...taskTargetShape,
  title: z.string().trim().min(1).optional().describe("New title."),
  description: z
    .string()
    .optional()
    .describe("New task body in markdown, replacing the current one. An empty string clears it."),
  done: z
    .boolean()
    .optional()
    .describe("Mark done or reopen. vikunja_complete_task is the shorthand for `true`."),
  priority: priorityField
    .optional()
    .describe("0 none, 1 low, 2 medium, 3 high, 4 urgent, 5 DO NOW."),
  due: clearableDueField
    .optional()
    .describe(
      'Due date as an RFC3339 timestamp, "2026-07-25T09:00:00Z". An empty string clears it.',
    ),
});

export function registerUpdateTasksTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_update_tasks",
    {
      title: "Update tasks",
      description:
        "Update several tasks in one call, each with its OWN set of fields — a heterogeneous batch " +
        "where every task carries a different patch. Each item names its task by key (`task`) or " +
        "global id and lists the fields to change: title, description, done, priority, due. Fields " +
        'left out keep their value; "" clears a description or due date. Labels and assignees ' +
        "cannot be changed here — passing either on an item is an error, exactly as " +
        "vikunja_update_task refuses them. Answers with { updated, failed }: `updated` holds the " +
        "tasks that changed as lean rows, `failed` holds the items that could not, each as " +
        "{ index, error } where `index` is the item's 0-based input position. A per-item write " +
        "failure is reported in `failed` while the other items still update — it does not fail the " +
        "whole call. The whole call is refused with nothing written only for a validation fault: an " +
        "empty list, an item that names no field to change, an unknown / ambiguous / archived / " +
        "nonexistent task, or the same task targeted twice. To set the SAME done, priority or due " +
        "across many tasks, use vikunja_bulk_update_tasks — one transaction — but this tool is the " +
        "one for differing edits, and it preserves the assignees, reminders and favourites that the " +
        "bulk endpoint would destroy.",
      // Strict at the call level too: a misspelled top-level argument is refused rather than dropped.
      inputSchema: z.strictObject({
        updates: z
          .array(updateItemSchema)
          .min(1)
          .describe("The tasks to update, each with its own patch. At least one."),
      }),
      // Destructive, like vikunja_update_task: replacing a description or due date overwrites it
      // with no history to recover the old value from, and the answer names both what changed and
      // what could not.
      annotations: { destructiveHint: true },
    },
    async ({ updates }) =>
      jsonResult(await applyTaskUpdates(client, resolver, updates, toTaskWrite, toLeanTask)),
  );
}
