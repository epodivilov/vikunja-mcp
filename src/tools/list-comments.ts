/**
 * `vikunja_list_comments` — the discussion on a task, as markdown.
 *
 * The read half of the comment surface: without it an agent can write a comment and never see
 * one, its own included. Bodies come back converted to markdown, and the author collapses to a
 * username — the projection drops the user object Vikunja expands into every row.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.ts";
import { toLeanComment } from "../projection.ts";
import type { Resolver } from "../resolver.ts";
import { jsonResult } from "./result.ts";
import { resolveTaskTarget, taskTargetShape } from "./task-target.ts";

export function registerListCommentsTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_list_comments",
    {
      title: "List task comments",
      description:
        "Lists every comment on a task as { id, comment, author?, created }, oldest first, with " +
        "the body as markdown. Every comment is returned — the result is never paginated away. " +
        "`id` is how vikunja_get_comment, vikunja_update_comment and vikunja_delete_comment " +
        "address one: comments have no key like INFRA-41.",
      inputSchema: z.strictObject({ ...taskTargetShape }),
      annotations: { readOnlyHint: true },
    },
    async ({ task, id }) => {
      const target = await resolveTaskTarget(client, resolver, { task, id });
      const comments = await client.listComments(target.id);

      return jsonResult(comments.map(toLeanComment));
    },
  );
}
