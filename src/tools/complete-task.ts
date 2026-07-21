/**
 * `vikunja_complete_task` — "done" without having to spell out an update.
 *
 * Separate from `vikunja_update_task` because it is the write an agent makes most often, and
 * because a client can allow just this one: completing a task cannot lose anything, while a
 * general update can overwrite a description.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VikunjaClient } from "../client.js";
import { toLeanTask } from "../projection.js";
import type { Resolver } from "../resolver.js";
import { resolveTaskTarget, taskTargetShape } from "./task-target.js";

export function registerCompleteTaskTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_complete_task",
    {
      title: "Complete task",
      description:
        "Mark a task done. Use vikunja_update_task to reopen one or to change anything else.",
      inputSchema: { ...taskTargetShape },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ task, id }) => {
      const target = await resolveTaskTarget(client, resolver, { task, id });

      // `client.updateTask` reads the task and sends it back with this patch applied — sending
      // `{ done: true }` on its own would strip every field the payload omits.
      await client.updateTask(target.id, { done: true });

      // Read back: the update response carries no server-filled key, and `done_at` is set by
      // the server rather than by us.
      const completed = await client.getTask(target.id);

      return { content: [{ type: "text", text: JSON.stringify(toLeanTask(completed)) }] };
    },
  );
}
