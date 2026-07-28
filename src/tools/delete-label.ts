/**
 * `vikunja_delete_label` — delete the label itself, not its association with a task.
 *
 * Its own tool so a client can deny exactly this one, for the reason `vikunja_delete_task` is:
 * this is irreversible, and its blast radius is wider than the object named. Deleting a label
 * takes it off every task carrying it — 142 of them for one label on the instance this was built
 * against — and Vikunja does that silently, with a plain 200 and no undo.
 *
 * Hence the count and the `force` guard: a label in use is refused once, with the number attached,
 * so the caller decides knowing what it costs. To take a label off one task, use
 * `vikunja_label_task` instead — this tool is for retiring the label everywhere.
 *
 * The count, the guard and the answer are `applyLabelDelete`, in a module the test suite can load;
 * this file is the schema, the annotations and one call.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import type { Resolver } from "../resolver.js";
import { applyLabelDelete, labelTargetShape } from "./label-fields.js";
import { jsonResult } from "./result.js";

export function registerDeleteLabelTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_delete_label",
    {
      title: "Delete label",
      description:
        "Permanently delete a label. This also takes it off every task that carries it, and " +
        "cannot be undone. A label still in use is refused unless force is true, and the refusal " +
        "says how many tasks carry it; the answer reports how many lost it. To take a label off " +
        "one task without deleting the label, use vikunja_label_task. Vikunja allows this only " +
        "to the label's own author — someone else's label answers 403 whatever your project " +
        "permissions.",
      // Strict: on an irreversible tool, an argument that is not understood is worth an error
      // rather than a guess at what the caller meant.
      inputSchema: z.strictObject({
        ...labelTargetShape,
        force: z
          .boolean()
          .optional()
          .describe(
            "Delete the label even though tasks carry it, detaching it from all of them. Call once without this to learn how many that is.",
          ),
      }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ label, force }) =>
      jsonResult(await applyLabelDelete(client, resolver, label, force ?? false)),
  );
}
