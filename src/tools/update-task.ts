/**
 * `vikunja_update_task` — change some fields of a task and leave the rest alone.
 *
 * "Leave the rest alone" is the whole difficulty: `POST /tasks/{id}` is not a partial update.
 * It writes a fixed column set and re-zeroes every field the payload omits, so a bare
 * `{ done: true }` strips the description, priority and dates off the task. `client.updateTask`
 * is the read-modify-write that answers this; the patch built here is what gets layered on.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import { markdownToHtml, toLeanTask } from "../projection.js";
import type { Resolver } from "../resolver.js";
import type { TaskWrite } from "../types.js";
import { dueField, priorityField } from "./task-fields.js";
import { resolveTaskTarget, taskTargetShape } from "./task-target.js";

export function registerUpdateTaskTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_update_task",
    {
      title: "Update task",
      description:
        "Change fields of an existing task. Fields left out keep their current value; fields passed replace it.",
      inputSchema: {
        ...taskTargetShape,
        title: z.string().trim().min(1).optional().describe("New title."),
        description: z
          .string()
          .optional()
          .describe(
            "New task body in markdown, replacing the current one. An empty string clears it.",
          ),
        done: z
          .boolean()
          .optional()
          .describe("Mark done or reopen. vikunja_complete_task is the shorthand for `true`."),
        priority: priorityField
          .optional()
          .describe("0 none, 1 low, 2 medium, 3 high, 4 urgent, 5 DO NOW."),
        due: dueField
          .optional()
          .describe('Due date as an RFC3339 timestamp, "2026-07-25T09:00:00Z".'),
      },
    },
    async ({ task, id, title, description, done, priority, due }) => {
      const write: TaskWrite = {};

      if (title !== undefined) {
        write.title = title;
      }
      if (description !== undefined) {
        write.description = markdownToHtml(description);
      }
      if (done !== undefined) {
        write.done = done;
      }
      if (priority !== undefined) {
        write.priority = priority;
      }
      if (due !== undefined) {
        write.due_date = due;
      }

      // Refused before the task is even resolved: an update carrying no fields would still cost
      // a write, and an agent that meant to change something deserves to hear that it did not.
      if (Object.keys(write).length === 0) {
        throw new Error(
          "Nothing to update: pass at least one of title, description, done, priority, due.",
        );
      }

      const target = await resolveTaskTarget(client, resolver, { task, id });
      await client.updateTask(target.id, write);

      // Read back rather than project the update response: Vikunja does not fill `identifier` in
      // on that path, it only echoes whatever the request happened to carry, and a task's key is
      // the one field of this answer that has to be right.
      const updated = await client.getTask(target.id);

      return { content: [{ type: "text", text: JSON.stringify(toLeanTask(updated)) }] };
    },
  );
}
