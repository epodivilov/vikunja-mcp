/**
 * `vikunja_update_comment` — replace a comment's body.
 *
 * Like `vikunja_comment_task`, the body arrives as markdown and is stored as HTML: Vikunja keeps
 * the string verbatim, so markdown left alone renders as literal asterisks in the UI. The work
 * itself is `applyCommentUpdate`, which lives in a module the test suite can load — this file is
 * the schema, the annotations and one call.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import { markdownToHtml } from "../projection.js";
import type { Resolver } from "../resolver.js";
import { jsonResult } from "./result.js";
import { applyCommentUpdate, commentTargetShape } from "./task-target.js";

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
        "old one wholesale — Vikunja keeps no history, so the previous text is gone; read the " +
        "comment first with vikunja_get_comment if you mean to amend rather than replace it. " +
        "Only the comment's author may edit it: write access to the project is not enough, and " +
        "someone else's comment answers 403 no matter your permissions. Name the task by key " +
        "(INFRA-41) and the comment by the `id` vikunja_list_comments reports.",
      // Strict: an argument this schema does not name is refused, not quietly dropped.
      inputSchema: z.strictObject({
        ...commentTargetShape,
        comment: z.string().trim().min(1).describe("The new comment body, in markdown."),
      }),
      // Destructive, and declared so: the old body is overwritten with no history to recover it
      // from, which is the same irreversibility `vikunja_update_task` has when it rewrites a
      // description. A client that auto-approves non-destructive writes must not get this one
      // for free. Idempotent, though — the same body written twice leaves the same comment.
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ task, id, commentId, comment }) =>
      jsonResult(
        await applyCommentUpdate(
          client,
          resolver,
          { task, id, commentId },
          comment,
          markdownToHtml,
        ),
      ),
  );
}
