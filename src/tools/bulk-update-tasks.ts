/**
 * `vikunja_bulk_update_tasks` — set the same field values across many tasks in one call.
 *
 * The alternative is N calls to `vikunja_update_task`, each a round trip of its own and each a
 * separate read-modify-write, so a failure halfway leaves the set half edited with nothing to say
 * which half. `POST /tasks/bulk` answers both: one HTTP write inside one transaction, and the one
 * place in this API where a column set can be written without re-zeroing everything else.
 *
 * Homogeneous by construction — the endpoint takes one `values` object for the whole set — and
 * deliberately narrow: `done`, `priority` and `due` are the three fields that mean something set
 * identically across many tasks. The same title on twenty tasks is a mistake far more often than
 * an intent, and a bulk description overwrite has no undo.
 *
 * The body lives in `task-target.ts`, not here: a test can load that module and cannot load this
 * one, and the ordering this tool depends on — resolve, vet, *then* write — is exactly what a
 * restated test body would leave unproved.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import { toLeanTask, toTaskWrite } from "../projection.js";
import type { Resolver } from "../resolver.js";
import { jsonResult } from "./result.js";
import { clearableDueField, priorityField } from "./task-fields.js";
import { applyBulkUpdate, bulkTaskTargetShape } from "./task-target.js";

export function registerBulkUpdateTasksTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_bulk_update_tasks",
    {
      title: "Bulk update tasks",
      description:
        "Set the same values of done, priority and/or due across many tasks in one write. Name " +
        "the tasks by key (INFRA-41), or by global id as the escape hatch; a task named twice is " +
        "written once. Every name is resolved before anything is written, so an unknown key " +
        "changes nothing, and the write itself is one transaction — the server either moves the " +
        "whole set or none of it. Fields not passed keep their current values, as do titles, " +
        "descriptions and labels. Tasks that carry assignees or reminders, or that you have " +
        "favourited, are refused by name: Vikunja's bulk endpoint destroys all three whatever it " +
        "is told to write, so change those with vikunja_update_task instead. A repeating task is " +
        "refused by name when this call would complete it — the bulk endpoint does not make a " +
        "completion stick on one, leaving it open with its dates unrolled and a done_at stamp on " +
        "it; complete those with vikunja_complete_task. Only that case is refused: setting " +
        "priority or due on a repeating task, or reopening one, goes through like any other task. " +
        "Answers with the tasks as the server holds them afterwards, read back rather than " +
        "echoed.",
      // Strict, like every other write schema here: a field this tool does not implement is
      // refused rather than dropped. On a call that writes a whole set, a silently ignored
      // argument would be a set changed in a way nobody described.
      inputSchema: z.strictObject({
        ...bulkTaskTargetShape,
        done: z.boolean().optional().describe("Mark every named task done, or reopen them all."),
        priority: priorityField
          .optional()
          .describe("0 none, 1 low, 2 medium, 3 high, 4 urgent, 5 DO NOW."),
        due: clearableDueField
          .optional()
          .describe(
            'Due date as an RFC3339 timestamp, "2026-07-25T09:00:00Z". An empty string clears it.',
          ),
      }),
      // Not idempotent, though not for the reason vikunja_complete_task is not: a repeating task
      // does NOT advance under this endpoint — probed on 2.3.0, the roll-forward it computes is
      // discarded — which is why those are refused outright rather than retried. What keeps the
      // hint false is that the set is re-resolved on every call, so a retry can legitimately land
      // differently: a target that has since gained an assignee, a reminder or a favourite now
      // refuses the whole call. `destructiveHint` is left at its default rather than claimed
      // false — this overwrites the named fields on every task in the set, with no history to
      // recover the old values from.
      annotations: { idempotentHint: false },
    },
    async ({ tasks, ids, done, priority, due }) =>
      jsonResult(
        await applyBulkUpdate(
          client,
          resolver,
          { tasks, ids },
          { done, priority, due },
          toTaskWrite,
          toLeanTask,
        ),
      ),
  );
}
