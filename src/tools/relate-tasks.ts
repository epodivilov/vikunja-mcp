/**
 * `vikunja_relate_tasks` — record that two tasks have something to do with each other.
 *
 * The whole tool is four steps in a fixed order, and the order is the design: validate the kind
 * (so a made-up one costs no request), resolve both keys to ids (the API addresses tasks by id,
 * and doing it here turns the server's permission error on an unreadable other task into a plain
 * "no such task"), write once, read back. The inverse relation is Vikunja's own write — `Create`
 * inserts both rows — so there is exactly one write here and never two.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.ts";
import { relatedProjectIds, toLeanTaskDetail } from "../projection.ts";
import type { Resolver } from "../resolver.ts";
import { RELATION_KINDS, parseRelationKind } from "../types.ts";
import { jsonResult } from "./result.ts";
import {
  OTHER_TASK_NAMES,
  otherTaskTargetShape,
  resolveTaskTarget,
  taskTargetShape,
} from "./task-target.ts";

export function registerRelateTasksTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_relate_tasks",
    {
      title: "Relate tasks",
      description:
        "Relate two tasks — a dependency, a subtask, a duplicate. The relation is filed on the " +
        "named task under `kind`, and Vikunja writes the mirror image on the other task itself " +
        "(blocking/blocked, subtask/parenttask, precedes/follows, duplicateof/duplicates, " +
        "copiedfrom/copiedto, related/related), so relate once, from whichever side reads " +
        'naturally. Direction is the named task\'s: { task: "INFRA-1", otherTask: "INFRA-2", ' +
        'kind: "blocking" } records that INFRA-1 blocks INFRA-2, while kind "subtask" files ' +
        "INFRA-2 among INFRA-1's subtasks. Answers with the named task and all its relations. " +
        "Vikunja refuses a relation that already exists, a task related to itself, and a " +
        "subtask/parenttask cycle; each comes back as an error. Read relations with " +
        "vikunja_get_task and remove one with vikunja_unrelate_tasks.",
      // Strict, and the kind is an enum: the vocabulary is Vikunja's, and an invented kind is
      // an error rather than a relation nobody can find again.
      inputSchema: z.strictObject({
        ...taskTargetShape,
        ...otherTaskTargetShape,
        kind: z
          .enum(RELATION_KINDS)
          .describe(
            "How the named task relates to the other one: subtask (the other is a subtask of " +
              "it), parenttask (it is a subtask of the other), blocking, blocked, precedes, " +
              "follows, duplicateof, duplicates, copiedfrom, copiedto, related.",
          ),
      }),
      annotations: { destructiveHint: false },
    },
    async ({ task, id, otherTask, otherId, kind }) => {
      // First, and before anything is read: the schema already names the vocabulary, and this
      // is the refusal that does not depend on the schema having been enforced.
      const relation = parseRelationKind(kind);

      const named = await resolveTaskTarget(client, resolver, { task, id });
      const other = await resolveTaskTarget(
        client,
        resolver,
        { task: otherTask, id: otherId },
        OTHER_TASK_NAMES,
      );

      await client.createRelation(named.id, other.id, relation);

      // Read back: `named` was read before the write, so its relations are one behind, and the
      // inverse row the server added is only visible on a fresh read.
      const updated = await client.getTask(named.id);
      const refOf = await resolver.taskRefLookup(relatedProjectIds(updated));

      return jsonResult(toLeanTaskDetail(updated, refOf));
    },
  );
}
