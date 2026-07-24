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
import { toLeanTask, toTaskWrite } from "../projection.js";
import type { Resolver } from "../resolver.js";
import { jsonResult } from "./result.js";
import { clearableDueField, priorityField } from "./task-fields.js";
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
        "Change fields of an existing task. Fields left out keep their current value; fields passed replace it. Labels are not task fields and cannot be changed here — use vikunja_label_task to add or remove some, or vikunja_set_task_labels to replace the whole set. Assignees cannot be changed here either. Passing either is an error rather than a silent no-op.",
      // Strict, so a field this tool does not implement is refused instead of dropped. A
      // non-strict schema would answer `{ labels: [...] }` with a success and an unchanged
      // task — Vikunja's own task update never touches the label link table — and the
      // description above would be the reason an agent believed it.
      inputSchema: z.strictObject({
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
        due: clearableDueField
          .optional()
          .describe(
            'Due date as an RFC3339 timestamp, "2026-07-25T09:00:00Z". An empty string clears it.',
          ),
      }),
    },
    async ({ task, id, title, description, done, priority, due }) => {
      const write = toTaskWrite({ title, description, done, priority, due });

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

      return jsonResult(toLeanTask(updated));
    },
  );
}
