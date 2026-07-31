/**
 * `vikunja_get_board` — a project's kanban board as ordered columns of lean tasks.
 *
 * Column membership lives only on the per-view kanban endpoint; `GET /tasks` carries no view
 * context and reports every task in bucket 0. The client reads that endpoint and exhausts its
 * unusual pagination, the resolver finds the kanban view and its mode, the projection strips each
 * bucket to a lean column — this file decides only which of the two project inputs was given.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.ts";
import { toLeanBoard } from "../projection.ts";
import type { Resolver } from "../resolver.ts";
import { jsonResult } from "./result.ts";

export function registerGetBoardTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_get_board",
    {
      title: "Get board",
      description:
        "Reads a project's kanban board as an ordered list of columns, each with its tasks as " +
        "lean rows, plus the board mode. On a `manual` board the columns are hand-managed buckets " +
        "a task can be moved between with vikunja_move_task; on a `filter` board they are defined " +
        "by filters, so a task moves between them by changing the fields those filters test — most " +
        "often its labels, via vikunja_label_task — not by a board move. Address the project by " +
        "key (e.g. INFRA); `projectId` is " +
        "the escape hatch for a project with no key. A project with no kanban view has no board and " +
        "is an error, not an empty result.",
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
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, projectId }) => {
      const id = await resolveProject(resolver, project, projectId);
      const view = await resolver.resolveKanbanView(id);
      const board = await client.readBoard(id, view.id);

      return jsonResult(toLeanBoard(view.mode, board));
    },
  );
}

/**
 * The project to read, as an id. Which of the two inputs was given is this layer's business;
 * what a key means, and whether a bare number is one, is the resolver's. The key is resolved
 * through the plain path, which allows an archived project: the view-tasks endpoint is
 * project-scoped and may serve an archived board where the global `GET /tasks` would not, so this
 * tool does not borrow the archive refusal the task-listing tools apply.
 */
async function resolveProject(
  resolver: Resolver,
  project: string | undefined,
  projectId: number | undefined,
): Promise<number> {
  if (project !== undefined && projectId !== undefined) {
    throw new Error(
      "Pass either project (a key such as INFRA) or projectId (a global id), not both.",
    );
  }

  if (projectId !== undefined) {
    return projectId;
  }

  if (project === undefined) {
    throw new Error(
      'Which project? Pass its key, e.g. { project: "INFRA" }, or its id as { projectId: 3 }.',
    );
  }

  return resolver.resolveProjectKey(project);
}
