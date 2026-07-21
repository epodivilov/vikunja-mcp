/**
 * `vikunja_list_projects` — the keys every other tool is addressed by.
 *
 * A thin adapter, like every file in this directory: it performs no HTTP and knows no Vikunja
 * shapes. The client fetches, the projection strips, this decides only what the tool is called
 * and what it says about itself.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VikunjaClient } from "../client.js";
import { toLeanProject } from "../projection.js";
import { jsonResult } from "./result.js";

export function registerListProjectsTool(server: McpServer, client: VikunjaClient): void {
  server.registerTool(
    "vikunja_list_projects",
    {
      title: "List projects",
      description:
        "Lists every project as { key, id, title }. The key (e.g. INFRA) is the prefix of " +
        "every task key in that project (INFRA-41), so this is the tool to call before " +
        "naming a project anywhere else. Archived projects are listed too, and a project " +
        "with no key at all comes back with an empty one — its tasks are reachable by id only.",
      annotations: { readOnlyHint: true },
    },
    async () => jsonResult((await client.listProjects()).map(toLeanProject)),
  );
}
