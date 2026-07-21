/**
 * `vikunja_list_tasks` — filtered task rows, lean enough to read a whole project at once.
 *
 * The filter expression itself is assembled in the client: `project_id = 11 && done = false`
 * is Vikunja dialect, and this layer is not allowed to know it. What happens here is input
 * validation and the key -> id translation, both of which are this layer's job.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import { toLeanTask } from "../projection.js";
import type { Resolver } from "../resolver.js";
import { jsonResult } from "./result.js";

const BARE_NUMBER = /^\d+$/;

export function registerListTasksTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_list_tasks",
    {
      title: "List tasks",
      description:
        "Lists tasks as lean rows: { ref, id, title, done, priority?, due?, labels }. `ref` " +
        "(INFRA-41) is how every other tool addresses a task. Every matching task is " +
        "returned — the result is never truncated — so filter by project unless you really " +
        "want every task on the instance. Descriptions are not included; read one task with " +
        "vikunja_get_task for that.",
      inputSchema: {
        project: z
          .string()
          .min(1)
          .optional()
          .describe("Project key, e.g. INFRA — the `key` field of vikunja_list_projects."),
        projectId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Global project id. Escape hatch for a project with no key; prefer `project`."),
        done: z
          .boolean()
          .optional()
          .describe("Restrict to done or to open tasks. Omitted returns both."),
        search: z.string().min(1).optional().describe("Free-text search, as the Vikunja UI does."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, projectId, done, search }) => {
      const tasks = await client.listTasks({
        projectId: await projectFilter(resolver, project, projectId),
        done,
        search,
      });

      return jsonResult(tasks.map(toLeanTask));
    },
  );
}

/**
 * The project to narrow to, as an id, or undefined for "every project".
 *
 * A bare number in `project` is refused rather than resolved. Vikunja would happily look for a
 * project whose key is literally "11" and answer "no project has that key", which reads as a
 * missing project when the real mistake was an id in the key's place — and the two are exactly
 * what this server exists to keep apart.
 */
async function projectFilter(
  resolver: Resolver,
  project: string | undefined,
  projectId: number | undefined,
): Promise<number | undefined> {
  if (project !== undefined && projectId !== undefined) {
    throw new Error(
      "Pass either project (a key such as INFRA) or projectId (a global id), not both.",
    );
  }

  if (projectId !== undefined) {
    return projectId;
  }

  if (project === undefined) {
    return undefined;
  }

  const key = project.trim();

  if (BARE_NUMBER.test(key)) {
    throw new Error(
      `"${key}" is a bare number, and a project is addressed by its key — e.g. INFRA. If you really mean the global id, pass it as { projectId: ${key} }.`,
    );
  }

  return resolver.resolveProjectKey(key);
}
