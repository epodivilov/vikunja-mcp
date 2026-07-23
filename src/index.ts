#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VikunjaClient, resolvePageSize } from "./client.js";
import { loadConfig } from "./config.js";
import { Resolver } from "./resolver.js";
import { registerCommentTaskTool } from "./tools/comment-task.js";
import { registerCompleteTaskTool } from "./tools/complete-task.js";
import { registerCreateTaskTool } from "./tools/create-task.js";
import { registerDeleteTaskTool } from "./tools/delete-task.js";
import { registerGetTaskTool } from "./tools/get-task.js";
import { registerListLabelsTool } from "./tools/list-labels.js";
import { registerListProjectsTool } from "./tools/list-projects.js";
import { registerListTasksTool } from "./tools/list-tasks.js";
import { registerUpdateTaskTool } from "./tools/update-task.js";

async function main(): Promise<void> {
  const config = loadConfig();
  // Discover the instance's page size from GET /info instead of guessing. index.ts owns the
  // one stderr sink, so the network layer stays free of `process`: resolvePageSize signals a
  // fallback through this callback rather than writing to stderr itself.
  const pageSize = await resolvePageSize(config, {
    warn: (message) => process.stderr.write(`vikunja-mcp: ${message}\n`),
  });
  const client = new VikunjaClient(config, { pageSize });
  const resolver = new Resolver(client);

  const server = new McpServer({
    name: "vikunja",
    version: "0.0.0",
  });

  // A tool that throws is turned into an MCP tool error by the SDK's own dispatcher, which
  // reports `error.message` verbatim — so an actionable message is the whole of the contract
  // a tool has to keep, and nothing here needs to wrap them.

  // Read tools. Safe to allow-list: every one of these carries readOnlyHint.
  registerListProjectsTool(server, client);
  registerListTasksTool(server, client, resolver);
  registerGetTaskTool(server, client, resolver);
  registerListLabelsTool(server, client);
  //       See CLAUDE.md -> "Tool surface". Each tool lives in src/tools/*.

  // Write tools. One per operation, and never behind a shared `subcommand` argument: an MCP
  // client has to be able to allow creating a task without also allowing deleting one.
  registerCreateTaskTool(server, client, resolver);
  registerUpdateTaskTool(server, client, resolver);
  registerCompleteTaskTool(server, client, resolver);
  registerCommentTaskTool(server, client, resolver);
  registerDeleteTaskTool(server, client, resolver);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`vikunja-mcp ready (host: ${config.baseUrl})\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
