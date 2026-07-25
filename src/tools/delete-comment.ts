/**
 * `vikunja_delete_comment` — its own tool so a client can deny exactly this one.
 *
 * The same isolation `vikunja_delete_task` gets, for the same reason: deletion is irreversible,
 * and Vikunja keeps no trash for comments. Reading and editing comments stay allowable without
 * also allowing them to be destroyed.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import { toLeanTask } from "../projection.js";
import type { Resolver } from "../resolver.js";
import { jsonResult } from "./result.js";
import { commentTargetShape, resolveCommentTarget } from "./task-target.js";

export function registerDeleteCommentTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_delete_comment",
    {
      title: "Delete task comment",
      description:
        "Permanently deletes one comment from a task. This cannot be undone — to change what a " +
        "comment says, use vikunja_update_comment instead. Only the comment's author may delete " +
        "it: write access to the project is not enough, and someone else's comment answers 403 " +
        "no matter your permissions. Name the task by key (INFRA-41) and the comment by the " +
        "`id` vikunja_list_comments reports.",
      // Strict: on an irreversible tool, an argument that is not understood is worth an error
      // rather than a guess at what the caller meant.
      inputSchema: z.strictObject({ ...commentTargetShape }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ task, id, commentId }) => {
      const target = await resolveCommentTarget(client, resolver, { task, id, commentId });
      const { ref } = toLeanTask(target.task);

      await client.deleteComment(target.task.id, target.commentId);

      return jsonResult({ deleted: true, ref, commentId: target.commentId });
    },
  );
}
