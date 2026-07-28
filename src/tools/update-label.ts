/**
 * `vikunja_update_label` — rename a label, recolour it, or both.
 *
 * This edits the label itself, instance-wide: every task carrying it reads the new title at once.
 * Renaming is safe for the kanban pipeline — the filter buckets on a board key on label *ids*,
 * not titles — which is why only the delete has a guard on it.
 *
 * `POST /labels/{id}` is a fixed-column write that zeroes what its payload omits, so the patch is
 * merged onto the whole stored record in `client.updateLabel`. That is also why the description
 * no schema here exposes survives an update rather than being blanked by one.
 *
 * The work itself is `applyLabelUpdate`, which lives in a module the test suite can load; this
 * file is the schema, the annotations and one call.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import { toLabelWrite, toLeanLabel } from "../projection.js";
import type { Resolver } from "../resolver.js";
import {
  applyLabelUpdate,
  labelColorField,
  labelTargetShape,
  labelTitleField,
} from "./label-fields.js";
import { jsonResult } from "./result.js";

export function registerUpdateLabelTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_update_label",
    {
      title: "Update label",
      description:
        "Rename a label and/or change its colour. The change is instance-wide: every task " +
        "carrying the label shows the new title. Fields the call does not name are left exactly " +
        "as they are. A title another label already holds is refused, since neither could then " +
        "be named by title. Vikunja allows this only to the label's own author — someone else's " +
        "label answers 403 whatever your project permissions.",
      // Strict: an argument this schema does not declare is refused rather than dropped, which
      // would report a change the caller asked for and the server never saw.
      inputSchema: z.strictObject({
        ...labelTargetShape,
        title: labelTitleField.optional().describe("The label's new title."),
        color: labelColorField
          .optional()
          .describe(
            'Six hex digits, with or without a leading "#" — "#0ea5e9". Pass "" to leave the label with no colour.',
          ),
      }),
      // Not destructive: it writes the fields it names and nothing else, and every one of them
      // can be written back. That is the difference from vikunja_update_comment and
      // vikunja_set_task_labels, which overwrite content the caller cannot recover.
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ label, title, color }) =>
      jsonResult(
        await applyLabelUpdate(client, resolver, { toLabelWrite, toLeanLabel }, label, {
          title,
          color,
        }),
      ),
  );
}
