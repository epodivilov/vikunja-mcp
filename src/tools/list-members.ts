/**
 * `vikunja_list_members` — who a project's tasks can be assigned to.
 *
 * Vikunja's own membership set, which is wider than the project's direct shares: its owner, the
 * users it is shared with, the members of every team it is shared with, and everything inherited
 * from parent projects. Assignment names people by username, and this is where those usernames
 * come from.
 *
 * The project is addressed by key like everywhere else. Deliberately the plain resolution, not the
 * archived-project refusal `vikunja_list_tasks` applies: this endpoint answers for an archived
 * project perfectly well, and refusing it here would be stricter than the server for no gain.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import { toLeanUser } from "../projection.js";
import type { Resolver } from "../resolver.js";
import { jsonResult } from "./result.js";

export function registerListMembersTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_list_members",
    {
      title: "List project members",
      description:
        "Lists the users a project's tasks can be assigned to as { id, username, name? } — its " +
        "owner, everyone it is shared with directly or through a team, and everyone inheriting " +
        "access from a parent project. `username` is how vikunja_assign_task names a user; `id` " +
        "is the escape hatch for a username two accounts share. Address the project by key (e.g. " +
        "INFRA); `projectId` is the escape hatch for a project with no key.",
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

      return jsonResult((await client.listProjectUsers(id)).map(toLeanUser));
    },
  );
}

/**
 * The project to read, as an id. Which of the two inputs was given is this layer's business; what
 * a key means, and whether a bare number is one, is the resolver's.
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
