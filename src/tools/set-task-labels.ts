/**
 * `vikunja_set_task_labels` — make a task's labels exactly this list.
 *
 * Split from `vikunja_label_task` by semantics, not by a mode argument: replacing a task's whole
 * label set detaches everything the list leaves out, and that is a decision the caller has to make
 * on purpose. Folding it into the incremental tool would hide it — a stale list echoed back would
 * quietly drop a label added since it was read — and an MCP client could no longer allow the
 * additive operation without also allowing the wholesale one.
 *
 * An empty list clears every label; the bulk endpoint has an explicit branch for it, and it is the
 * documented way to do that.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import { toLeanTask } from "../projection.js";
import type { Resolver } from "../resolver.js";
import { jsonResult } from "./result.js";
import { resolveTaskTarget, taskTargetShape } from "./task-target.js";

/** A label as an agent names it: the title it read in a listing, or the id printed beside it. */
const labelRef = z.union([z.string(), z.number().int().positive()]);

export function registerSetTaskLabelsTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_set_task_labels",
    {
      title: "Set task labels",
      description:
        "Replace a task's labels with exactly the list passed: labels in it are attached, labels " +
        "on the task but not in it are detached, and an empty list clears them all. The whole set " +
        "lands in one write. Labels are never created here — an unknown one is an error and " +
        "nothing is changed. Use vikunja_label_task to add or remove a few labels without " +
        "touching the rest, which is usually what you want.",
      // Strict: an argument this schema does not declare is refused rather than dropped, which on
      // a wholesale replace would mean silently writing a set the caller did not describe.
      inputSchema: z.strictObject({
        ...taskTargetShape,
        labels: z
          .array(labelRef)
          .describe(
            "The complete set of labels the task should end up with, each named by title or by the id vikunja_list_labels reports. Anything currently on the task and absent here is detached; an empty array leaves the task with no labels.",
          ),
      }),
      // destructiveHint is left at its default of true, and that is the honest reading: this call
      // detaches every label it does not name, and `[]` detaches all of them. A client that gates
      // destructive tools should gate this one and still be free to allow vikunja_label_task.
      annotations: { idempotentHint: true },
    },
    async ({ task, id, labels }) => {
      const target = await resolveTaskTarget(client, resolver, { task, id });

      // Every reference resolved before anything is written, so an unknown or ambiguous label
      // fails with the task's labels untouched rather than half-replaced.
      const labelIds = await resolver.resolveLabelIds(labels);

      await client.setTaskLabels(target.id, labelIds);

      // Read back: the bulk endpoint's answer is the request's own label array, not the stored
      // set, and this answer has to report what the server actually holds.
      const updated = await client.getTask(target.id);

      return jsonResult(toLeanTask(updated));
    },
  );
}
