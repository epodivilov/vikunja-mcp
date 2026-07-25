/**
 * `vikunja_update_comment` — replace a comment's body.
 *
 * Like `vikunja_comment_task`, the body arrives as markdown and is converted here: Vikunja
 * stores the string verbatim, so markdown left alone renders as literal asterisks in the UI.
 * The write itself replaces the body and nothing else — the server's Update touches the
 * `comment` column only, and author and timestamps are its business, not ours.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import { markdownToHtml, toLeanTask } from "../projection.js";
import type { Resolver } from "../resolver.js";
import { jsonResult } from "./result.js";
import { commentTargetShape, resolveCommentTarget } from "./task-target.js";

export function registerUpdateCommentTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_update_comment",
    {
      title: "Update task comment",
      description:
        "Replaces the body of an existing comment. The new body is markdown and overwrites the " +
        "old one wholesale — read the comment first with vikunja_get_comment if you mean to " +
        "amend rather than replace it. Name the task by key (INFRA-41) and the comment by the " +
        "`id` vikunja_list_comments reports.",
      // Strict: an argument this schema does not name is refused, not quietly dropped.
      inputSchema: z.strictObject({
        ...commentTargetShape,
        comment: z.string().trim().min(1).describe("The new comment body, in markdown."),
      }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ task, id, commentId, comment }) => {
      const target = await resolveCommentTarget(client, resolver, { task, id, commentId });
      await client.updateComment(target.task.id, target.commentId, markdownToHtml(comment));

      // The task's key, from the task that was just read: it names where the comment lives, which
      // is the one thing the id alone cannot say.
      const { ref } = toLeanTask(target.task);

      return jsonResult({ ref, commentId: target.commentId });
    },
  );
}
