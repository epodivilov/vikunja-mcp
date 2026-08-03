/**
 * `vikunja_unassign_task` — take a task off one or more people.
 *
 * The candidate set is the task's own assignees, not the project's members: someone who has left
 * the project is still assigned and must stay removable, while someone who was never assigned must
 * not come back as a success. Vikunja itself will not draw that second line — the delete endpoint
 * never checks that the assignment existed and answers 200 either way — so the refusal is ours,
 * and it names who is assigned instead.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.ts";
import { toLeanTask } from "../projection.ts";
import type { Resolver } from "../resolver.ts";
import { jsonResult } from "./result.ts";
import { resolveTaskTarget, taskTargetShape } from "./task-target.ts";
import { usersField } from "./user-fields.ts";

export function registerUnassignTaskTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_unassign_task",
    {
      title: "Unassign task",
      description:
        "Removes one or more users from a task, leaving the rest assigned. Name the task by key " +
        "(INFRA-41) and each user by the username the task itself reports, or by global id. " +
        "Naming someone who is not assigned is an error that lists who is — not a silent success " +
        "— and a call naming several users removes none of them unless every name resolves. " +
        "Answers with the task as it now stands.",
      inputSchema: z.strictObject({
        ...taskTargetShape,
        users: usersField.describe(
          "The users to unassign, each by the username shown in the task's `assignees`, or by " +
            "global id.",
        ),
      }),
      annotations: { destructiveHint: false },
    },
    async ({ task, id, users }) => {
      const target = await resolveTaskTarget(client, resolver, { task, id });

      // The task carries its assignees, so the whole call is validated against them before the
      // first DELETE — no extra request, and nothing removed when one name is wrong.
      const userIds = resolver.resolveUnassigneeIds(target.assignees ?? [], users);

      for (const userId of userIds) {
        await client.removeTaskAssignee(target.id, userId);
      }

      return jsonResult(toLeanTask(await client.getTask(target.id)));
    },
  );
}
