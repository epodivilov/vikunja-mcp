/**
 * `vikunja_list_labels` — the id behind a label name.
 *
 * Tasks carry label titles in the lean projection, but Vikunja addresses labels by id, so this
 * is the mapping a caller needs before it can speak about one.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VikunjaClient } from "../client.js";
import { toLeanLabel } from "../projection.js";
import { jsonResult } from "./result.js";

export function registerListLabelsTool(server: McpServer, client: VikunjaClient): void {
  server.registerTool(
    "vikunja_list_labels",
    {
      title: "List labels",
      description:
        "Lists every label available to you as { id, title, color? }, the colour being six hex " +
        "digits and absent when the label has none. Task listings show label titles; this is " +
        "how a title maps to the id Vikunja addresses it by, which is also what disambiguates a " +
        "title two labels share.",
      annotations: { readOnlyHint: true },
    },
    async () => jsonResult((await client.listLabels()).map(toLeanLabel)),
  );
}
