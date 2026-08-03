/**
 * The entry point's tool-registration list, lifted out of `main()` so it can be driven from a
 * test against a caller-supplied server object — without loading configuration, opening a
 * transport, or making a network request. `registerTool` only stores the handler, so calling
 * this dials nothing out; it is the one seam a test needs to assert the served surface and its
 * annotations. `index.ts` keeps ownership of the transport and the config; this owns only the
 * list.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VikunjaClient } from "./client.ts";
import type { Resolver } from "./resolver.ts";
import { registerAssignTaskTool } from "./tools/assign-task.ts";
import { registerBulkUpdateTasksTool } from "./tools/bulk-update-tasks.ts";
import { registerCommentTaskTool } from "./tools/comment-task.ts";
import { registerCompleteTaskTool } from "./tools/complete-task.ts";
import { registerCreateLabelTool } from "./tools/create-label.ts";
import { registerCreateTaskTool } from "./tools/create-task.ts";
import { registerDeleteCommentTool } from "./tools/delete-comment.ts";
import { registerDeleteLabelTool } from "./tools/delete-label.ts";
import { registerDeleteTaskTool } from "./tools/delete-task.ts";
import { registerGetBoardTool } from "./tools/get-board.ts";
import { registerGetCommentTool } from "./tools/get-comment.ts";
import { registerGetTaskTool } from "./tools/get-task.ts";
import { registerLabelTaskTool } from "./tools/label-task.ts";
import { registerListCommentsTool } from "./tools/list-comments.ts";
import { registerListLabelsTool } from "./tools/list-labels.ts";
import { registerListMembersTool } from "./tools/list-members.ts";
import { registerListProjectsTool } from "./tools/list-projects.ts";
import { registerListTasksTool } from "./tools/list-tasks.ts";
import { registerMoveTaskTool } from "./tools/move-task.ts";
import { registerRelateTasksTool } from "./tools/relate-tasks.ts";
import { registerSetTaskLabelsTool } from "./tools/set-task-labels.ts";
import { registerUnassignTaskTool } from "./tools/unassign-task.ts";
import { registerUnrelateTasksTool } from "./tools/unrelate-tasks.ts";
import { registerUpdateCommentTool } from "./tools/update-comment.ts";
import { registerUpdateLabelTool } from "./tools/update-label.ts";
import { registerUpdateTaskTool } from "./tools/update-task.ts";

/**
 * Register every tool on `server`. Read and write tools stay grouped and separately annotated:
 * an MCP client has to be able to allow the reads without also allowing a delete, which is a
 * primary reason this project splits one tool per operation. See CLAUDE.md -> "Tool surface".
 */
export function registerAllTools(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  // Read tools. Safe to allow-list: every one of these carries readOnlyHint.
  registerListProjectsTool(server, client);
  registerListTasksTool(server, client, resolver);
  registerGetTaskTool(server, client, resolver);
  registerListLabelsTool(server, client);
  registerGetBoardTool(server, client, resolver);
  registerListMembersTool(server, client, resolver);
  registerListCommentsTool(server, client, resolver);
  registerGetCommentTool(server, client, resolver);

  // Write tools. One per operation, and never behind a shared `subcommand` argument: an MCP
  // client has to be able to allow creating a task without also allowing deleting one.
  registerCreateTaskTool(server, client, resolver);
  registerUpdateTaskTool(server, client, resolver);
  registerBulkUpdateTasksTool(server, client, resolver);
  registerCompleteTaskTool(server, client, resolver);
  registerCommentTaskTool(server, client, resolver);
  registerUpdateCommentTool(server, client, resolver);
  registerMoveTaskTool(server, client, resolver);
  registerLabelTaskTool(server, client, resolver);
  registerSetTaskLabelsTool(server, client, resolver);
  registerCreateLabelTool(server, client, resolver);
  registerUpdateLabelTool(server, client, resolver);
  registerAssignTaskTool(server, client, resolver);
  registerUnassignTaskTool(server, client, resolver);
  registerRelateTasksTool(server, client, resolver);
  registerUnrelateTasksTool(server, client, resolver);
  registerDeleteTaskTool(server, client, resolver);
  registerDeleteCommentTool(server, client, resolver);
  registerDeleteLabelTool(server, client, resolver);
}
