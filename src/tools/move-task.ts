/**
 * `vikunja_move_task` — move a task into a named column on a manual-bucket board.
 *
 * Only a manual board models a column move as a real mutation (a `task_buckets` row). A filter
 * board's columns are synthesized from filters, so nothing can be moved there by a bucket op — the
 * tool refuses and names the mechanism that does move a task. The task is addressed by key like
 * every other write; the column by its name, since bucket ids are internal and, on a filter board,
 * meaningless array indices.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import { toLeanTask } from "../projection.js";
import type { Resolver } from "../resolver.js";
import { jsonResult } from "./result.js";
import { resolveTaskTarget, taskTargetShape } from "./task-target.js";

export function registerMoveTaskTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_move_task",
    {
      title: "Move task",
      description:
        "Move a task into a named column of its project's kanban board. Works only on a manual " +
        "board, where columns are hand-managed buckets; on a filter board the columns are defined " +
        "by filters, so the task moves by changing the fields those filters test (e.g. its labels) " +
        "— this tool refuses there and says so. Moving into or out of the board's Done column flips " +
        "the task's done state server-side, and a column at its WIP limit rejects the move. Name " +
        "the task by key (INFRA-41) and the column by its name, exactly as vikunja_get_board reports it.",
      inputSchema: z.strictObject({
        ...taskTargetShape,
        column: z
          .string()
          .trim()
          .min(1)
          .describe('Target column name, exactly as vikunja_get_board reports it, e.g. "Doing".'),
      }),
      annotations: { destructiveHint: false },
    },
    async ({ task, id, column }) => {
      const target = await resolveTaskTarget(client, resolver, { task, id });
      const view = await resolver.resolveKanbanView(target.project_id);

      // Refused before any mutation: a filter board has no `task_buckets` rows to write, so there
      // is nothing to move. The message names the real mechanism rather than failing opaquely.
      if (view.mode !== "manual") {
        throw new Error(
          `${target.identifier} sits on a filter-mode board, whose columns are defined by filters, not hand-managed buckets. A task moves between them by changing the fields those filters test — most often its labels, via vikunja_update_task — not by a board move.`,
        );
      }

      const bucketId = await resolver.resolveBucketId(target.project_id, view.id, column);
      await client.moveTask(target.project_id, view.id, bucketId, target.id);

      // Read back: the move can flip `done` server-side (into or out of the done column), so the
      // task's state after it is the server's to report, not ours to assume.
      const moved = await client.getTask(target.id);

      return jsonResult(toLeanTask(moved));
    },
  );
}
