/**
 * `vikunja_get_comment` — one comment, by the task it sits on and its own id.
 *
 * Both are required because both are the address: Vikunja's handler matches the comment's task
 * against the one in the URL, so a comment id alone names nothing.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.ts";
import { toLeanComment } from "../projection.ts";
import type { Resolver } from "../resolver.ts";
import { jsonResult } from "./result.ts";
import { commentTargetShape, resolveCommentTarget } from "./task-target.ts";

export function registerGetCommentTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_get_comment",
    {
      title: "Get task comment",
      description:
        "Reads one comment as { id, comment, author?, created }, its body converted to markdown. " +
        "Name the task by key (INFRA-41) and the comment by the `id` vikunja_list_comments " +
        "reports; the comment has to belong to that task.",
      inputSchema: z.strictObject({ ...commentTargetShape }),
      annotations: { readOnlyHint: true },
    },
    async ({ task, id, commentId }) => {
      const target = await resolveCommentTarget(client, resolver, { task, id, commentId });
      const comment = await client.getComment(target.task.id, target.commentId);

      return jsonResult(toLeanComment(comment));
    },
  );
}
