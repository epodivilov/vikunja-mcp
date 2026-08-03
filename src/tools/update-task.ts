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
import type { VikunjaClient } from "../client.ts";
import { toLeanTask, toTaskWrite } from "../projection.ts";
import type { Resolver } from "../resolver.ts";
import { jsonResult } from "./result.ts";
import { clearableDueField, priorityField } from "./task-fields.ts";
import { resolveTaskTarget, taskTargetShape } from "./task-target.ts";

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
        "Change fields of an existing task. Fields left out keep their current value; fields passed replace it. Labels are not task fields and cannot be changed here — use vikunja_label_task to add or remove some, or vikunja_set_task_labels to replace the whole set. Assignees cannot be changed here either. Passing either is an error rather than a silent no-op. To set the same done, priority or due across several tasks, use vikunja_bulk_update_tasks: it is one call and one transaction instead of one of these per task — though this tool remains the one that can touch a task carrying assignees or reminders, which the bulk endpoint destroys.",
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
      // Destructive, and declared so rather than left to the MCP default: replacing a
      // description overwrites it with no history to recover the old text from — the same
      // irreversibility vikunja_update_comment names. The default already resolves to `true`, so
      // stating it changes nothing for a client that applies the defaults and moves a client that
      // reads hints verbatim from unstated to explicit `true`, the conservative direction.
      annotations: { destructiveHint: true },
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
