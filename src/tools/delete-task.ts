/**
 * `vikunja_delete_task` — its own tool so a client can deny exactly this one.
 *
 * That isolation is the point: deletion is the single irreversible operation in the surface,
 * and folding it into a general "task" tool would mean allowing it to allow anything else.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import { toLeanTask } from "../projection.js";
import type { Resolver } from "../resolver.js";
import { resolveTaskTarget, taskTargetShape } from "./task-target.js";

export function registerDeleteTaskTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_delete_task",
    {
      title: "Delete task",
      description:
        "Permanently delete a task, along with its comments. This cannot be undone — to close a task instead, use vikunja_complete_task.",
      // Strict: on the one irreversible tool, an argument that is not understood is worth an
      // error rather than a guess at what the caller meant.
      inputSchema: z.strictObject({ ...taskTargetShape }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ task, id }) => {
      // Read first: the task has to be named in the answer, and it can no longer be read
      // afterwards. It also turns "delete something that does not exist" into a plain error
      // before anything is destroyed.
      const target = await resolveTaskTarget(client, resolver, { task, id });
      const { ref, title } = toLeanTask(target);

      await client.deleteTask(target.id);

      return {
        content: [
          { type: "text", text: JSON.stringify({ deleted: true, ref, id: target.id, title }) },
        ],
      };
    },
  );
}
