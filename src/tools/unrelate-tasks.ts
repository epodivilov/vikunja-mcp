/**
 * `vikunja_unrelate_tasks` — remove one relation between two tasks.
 *
 * The mirror of `vikunja_relate_tasks`, down to the order: validate the kind, resolve both keys,
 * one delete, read back. The kind has to be named because two tasks may hold several relations
 * at once — dropping "the relation between A and B" would be ambiguous. Vikunja removes both
 * directions on this single call.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import { relatedProjectIds, toLeanTaskDetail } from "../projection.js";
import type { Resolver } from "../resolver.js";
import { RELATION_KINDS, parseRelationKind } from "../types.js";
import { jsonResult } from "./result.js";
import {
  OTHER_TASK_NAMES,
  otherTaskTargetShape,
  resolveTaskTarget,
  taskTargetShape,
} from "./task-target.js";

export function registerUnrelateTasksTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_unrelate_tasks",
    {
      title: "Unrelate tasks",
      description:
        "Remove one relation between two tasks. Name the same kind the relation was recorded " +
        'under, read from the named task\'s side: { task: "INFRA-1", otherTask: "INFRA-2", ' +
        'kind: "blocking" } drops "INFRA-1 blocks INFRA-2" — and with it the mirror image on ' +
        "INFRA-2, which Vikunja removes in the same call. Two tasks can hold several relations " +
        "at once, so only the kind named here is removed; the others stay. A relation that is " +
        "not there is an error, not a silent success. Answers with the named task and the " +
        "relations it has left. List them first with vikunja_get_task.",
      inputSchema: z.strictObject({
        ...taskTargetShape,
        ...otherTaskTargetShape,
        kind: z
          .enum(RELATION_KINDS)
          .describe(
            "The kind to remove, exactly as vikunja_get_task reports it on the named task: " +
              "subtask, parenttask, blocking, blocked, precedes, follows, duplicateof, " +
              "duplicates, copiedfrom, copiedto, related.",
          ),
      }),
      // Destructive: it removes a relation, and the relation is not recoverable from the answer.
      annotations: { destructiveHint: true },
    },
    async ({ task, id, otherTask, otherId, kind }) => {
      const relation = parseRelationKind(kind);

      const named = await resolveTaskTarget(client, resolver, { task, id });
      const other = await resolveTaskTarget(
        client,
        resolver,
        { task: otherTask, id: otherId },
        OTHER_TASK_NAMES,
      );

      await client.deleteRelation(named.id, relation, other.id);

      // Read back rather than subtract the relation from the copy in hand: what is left is the
      // server's account of the task, and the delete may have removed more than one row.
      const updated = await client.getTask(named.id);
      const refOf = await resolver.taskRefLookup(relatedProjectIds(updated));

      return jsonResult(toLeanTaskDetail(updated, refOf));
    },
  );
}
