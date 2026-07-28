/**
 * `vikunja_create_label` — bring a label into existence.
 *
 * The counterpart to `vikunja_label_task`, which only ever attaches one that already exists. That
 * split is deliberate: a label is created rarely and on purpose, while attaching one is frequent,
 * and a tool that created labels implicitly would turn every typo into a new label nobody meant.
 *
 * Two refusals here are ours rather than the server's — an empty title and a title another label
 * already holds — because Vikunja accepts both with a 201, and both leave a label that no tool
 * can name afterwards. Both live in `applyLabelCreate`, in a module the test suite can load; this
 * file is the schema, the annotations and one call.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import { toLabelWrite, toLeanLabel } from "../projection.js";
import type { Resolver } from "../resolver.js";
import { applyLabelCreate, labelColorField, labelTitleField } from "./label-fields.js";
import { jsonResult } from "./result.js";

export function registerCreateLabelTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_create_label",
    {
      title: "Create label",
      description:
        "Create a label, instance-wide — labels in Vikunja are not scoped to a project. Answers " +
        "with the label's id, which is how it is addressed when its title turns out to be " +
        "shared. A title another label already holds is refused: Vikunja would allow the " +
        "duplicate, but then neither label could be named by its title anywhere. To put an " +
        "existing label on a task use vikunja_label_task.",
      // Strict: a misspelled argument is refused rather than dropped, which would create a label
      // missing the very field the caller asked for.
      inputSchema: z.strictObject({
        title: labelTitleField.describe("The label's title, as it will read in every listing."),
        color: labelColorField
          .optional()
          .describe(
            'Six hex digits, with or without a leading "#" — "#0ea5e9". Omit it, or pass "", for a label with no colour.',
          ),
      }),
      // Not destructive: it adds a label and touches nothing that exists. Not idempotent either —
      // calling it twice would mean two labels, which is exactly what the duplicate-title refusal
      // is there to prevent.
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ title, color }) =>
      jsonResult(
        await applyLabelCreate(client, resolver, { toLabelWrite, toLeanLabel }, { title, color }),
      ),
  );
}
