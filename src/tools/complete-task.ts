/**
 * `vikunja_complete_task` — "done" without having to spell out an update.
 *
 * Separate from `vikunja_update_task` because it is the write an agent makes most often, and
 * because a client can allow just this one: it writes the single field its name promises, while
 * a general update can overwrite a description.
 *
 * It is not a no-op when repeated. Completing a task that Vikunja repeats does not leave it
 * done — the server rolls it forward by `repeat_after` and hands it back open — so a second
 * call moves it on again. Verified on 2.3.0 against a task repeating daily: three completes,
 * three answers of `done: false`, and a due date a day further along each time. The answer here
 * says so, because it is read back from the server rather than assumed.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import { toLeanTask } from "../projection.js";
import type { Resolver } from "../resolver.js";
import { jsonResult } from "./result.js";
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
        "Mark a task done. A repeating task does not end up done: Vikunja moves it to its next occurrence and answers with it still open, so calling this twice advances it twice — check the answer rather than retrying. Use vikunja_update_task to reopen a task or to change anything else.",
      inputSchema: z.strictObject({ ...taskTargetShape }),
      // Not idempotent, and the hint has to say so: on a repeating task each call walks the
      // dates forward, so a client that retried this one "for free" would move a task days out.
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ task, id }) => {
      const target = await resolveTaskTarget(client, resolver, { task, id });

      // `client.updateTask` reads the task and sends it back with this patch applied — sending
      // `{ done: true }` on its own would strip every field the payload omits.
      await client.updateTask(target.id, { done: true });

      // Read back: the update response carries no server-filled key, and `done_at` is set by
      // the server rather than by us.
      const completed = await client.getTask(target.id);

      return jsonResult(toLeanTask(completed));
    },
  );
}
