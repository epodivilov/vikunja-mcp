/**
 * `vikunja_label_task` — add labels to a task, take labels off it, or both at once.
 *
 * Incremental: labels the call does not name keep whatever state they had. That is the difference
 * from `vikunja_set_task_labels`, which writes the list it is given and detaches everything else.
 *
 * Labels are not task fields — `POST /tasks/{id}` never touches the link table — so they cannot be
 * changed through `vikunja_update_task` at all. They have their own endpoint, and this tool and
 * its declarative twin are the only ways to reach it.
 *
 * The write is a single request whatever the call asks for: the resulting label set is computed
 * from the ones the task already carries (which arrived with the task, for free) and handed to the
 * bulk endpoint, which reconciles to it in one transaction. Adds and removes therefore land
 * together — a label-filtered board never sees the task between two columns — and a failure leaves
 * the labels exactly as they were.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.ts";
import { toLeanTask } from "../projection.ts";
import type { Resolver } from "../resolver.ts";
import { jsonResult } from "./result.ts";
import { resolveTaskTarget, taskTargetShape } from "./task-target.ts";

/** A label as an agent names it: the title it read in a listing, or the id printed beside it. */
const labelRef = z.union([z.string(), z.number().int().positive()]);

export function registerLabelTaskTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_label_task",
    {
      title: "Label task",
      description:
        "Add labels to a task and/or take labels off it, leaving every label the call does not " +
        "name in place. Both lists take effect in one write, so the task is never left half-" +
        "labelled. Adding a label the task already carries, or removing one it does not, is not " +
        "an error — it changes nothing. Labels are never created here: an unknown one named in " +
        "`add` is an error. Use vikunja_set_task_labels to replace the whole set or clear it. " +
        "This is also how a task moves between the columns of a filter-mode kanban board, whose " +
        "columns filter on labels.",
      // Strict: `labels` (this tool's argument is `add`/`remove`), `assignees`, a misspelling —
      // all refused rather than accepted and dropped, which would report a change nobody made.
      inputSchema: z.strictObject({
        ...taskTargetShape,
        add: z
          .array(labelRef)
          .optional()
          .describe(
            "Existing labels to put on the task, each named by title or by the id vikunja_list_labels reports. Pass an id when a title turns out to be shared by several labels.",
          ),
        remove: z
          .array(labelRef)
          .optional()
          .describe(
            "Labels to take off the task, named by title or id. Matched against the labels the task actually carries, so a title shared instance-wide is unambiguous here, and naming one the task does not carry does nothing.",
          ),
      }),
      // Not destructive: it edits an association the same way an update edits a field, and only
      // the ones named. Idempotent because the endpoint reconciles to a set — the same call twice
      // leaves the same labels, which is what makes a retry safe.
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ task, id, add, remove }) => {
      // The task arrives with its labels, so `current` costs no request of its own — and reading
      // them a second time would only be a second chance to be stale.
      const target = await resolveTaskTarget(client, resolver, { task, id });

      // Both refusals — a call naming no label, and one naming a label on both sides — happen
      // here, before the write. They live in the resolver rather than in this file because that
      // is the layer a test can reach.
      const next = await resolver.resolveLabelChange(target.labels ?? [], { add, remove });

      await client.setTaskLabels(target.id, next);

      // Read back: the bulk endpoint echoes the array it was handed rather than the stored set,
      // and the labels this answer reports have to be the ones the server now has.
      const labelled = await client.getTask(target.id);

      return jsonResult(toLeanTask(labelled));
    },
  );
}
