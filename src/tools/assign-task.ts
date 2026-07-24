/**
 * `vikunja_assign_task` — hand a task to one or more people.
 *
 * Additive: everyone already assigned stays assigned, and a user named here who is already on the
 * task costs no write at all. That skip is not politeness — `PUT /tasks/{id}/assignees` refuses a
 * duplicate with code 4021, which in a multi-user call would abort the run halfway through with
 * part of it applied.
 *
 * Every name is resolved before the first write, so a call naming one good and one bad user
 * changes nothing. Users are named by username; the global id is the escape hatch for a username
 * two accounts share, and — unlike a username — it is not checked against the member listing,
 * because whether a user may be assigned is the server's own access check to make.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import { toLeanTask } from "../projection.js";
import type { Resolver } from "../resolver.js";
import { jsonResult } from "./result.js";
import { resolveTaskTarget, taskTargetShape } from "./task-target.js";
import { usersField } from "./user-fields.js";

export function registerAssignTaskTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_assign_task",
    {
      title: "Assign task",
      description:
        "Assigns one or more users to a task, keeping whoever is already assigned. Name the task " +
        "by key (INFRA-41) and each user by username, exactly as vikunja_list_members reports it; " +
        "a numeric id is the escape hatch for a username two accounts share. A user already " +
        "assigned is skipped rather than re-assigned, and a name that matches no member — or more " +
        "than one — fails the whole call before anything is written. Answers with the task, " +
        "listing everyone now assigned to it.",
      inputSchema: z.strictObject({
        ...taskTargetShape,
        users: usersField.describe(
          "The users to assign, each by username (preferred) or by the global id " +
            "vikunja_list_members reports beside it.",
        ),
      }),
      annotations: { destructiveHint: false },
    },
    async ({ task, id, users }) => {
      const target = await resolveTaskTarget(client, resolver, { task, id });

      // Resolved in full before the first write, and diffed against the task's current assignees
      // — which arrived with the task itself, so this costs no extra read.
      const userIds = await resolver.resolveAssigneeIds(
        target.project_id,
        target.assignees ?? [],
        users,
      );

      for (const userId of userIds) {
        await client.addTaskAssignee(target.id, userId);
      }

      // Read back rather than assume: the answer has to name the assignees the server actually
      // stored, and their usernames are nowhere in the write requests we just issued.
      return jsonResult(toLeanTask(await client.getTask(target.id)));
    },
  );
}
