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
        "(INFRA-41) is how every other tool addresses a task. Every matching task is returned " +
        "— the result is never paginated away — so filter by project unless you really want " +
        "every task on the instance. One exception, and it is Vikunja's: tasks of archived " +
        "projects are in no task listing at all, whatever the filter says. Read one of those " +
        "by id with vikunja_get_task, or unarchive the project. Descriptions are not included; " +
        "read one task with vikunja_get_task for that.",
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
 * Which of the two arguments was given is this layer's business; what a key means, whether a
 * bare number is one, and whether the project it names can answer a task query at all are the
 * resolver's. Hence the single call: everything that could be said about the key is said there,
 * once, for every tool that resolves one.
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

  return project === undefined ? undefined : resolver.resolveProjectForTasks(project);
}
