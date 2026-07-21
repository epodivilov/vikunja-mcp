/**
 * `vikunja_comment_task` — a comment on a task.
 *
 * Comments are stored like descriptions: verbatim HTML, converted by nobody, so markdown left
 * as-is renders as literal asterisks in the UI. The conversion happens here.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import { markdownToHtml, toLeanTask } from "../projection.js";
import type { Resolver } from "../resolver.js";
import { resolveTaskTarget, taskTargetShape } from "./task-target.js";

export function registerCommentTaskTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_comment_task",
    {
      title: "Comment on task",
      description: "Add a comment to a task. The comment body is markdown.",
      inputSchema: {
        ...taskTargetShape,
        comment: z.string().trim().min(1).describe("Comment body in markdown."),
      },
      annotations: { destructiveHint: false },
    },
    async ({ task, id, comment }) => {
      const target = await resolveTaskTarget(client, resolver, { task, id });
      const created = await client.createComment(target.id, markdownToHtml(comment));

      // The key comes from the task that was just read, not from the comment: it names which
      // task the comment landed on, which is the one thing worth answering with.
      const { ref } = toLeanTask(target);

      return {
        content: [{ type: "text", text: JSON.stringify({ ref, commentId: created.id }) }],
      };
    },
  );
}
