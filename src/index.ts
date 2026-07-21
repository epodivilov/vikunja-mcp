#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VikunjaClient } from "./client.js";
import { loadConfig } from "./config.js";
import { Resolver } from "./resolver.js";
import { registerGetTaskTool } from "./tools/get-task.js";
import { registerListLabelsTool } from "./tools/list-labels.js";
import { registerListProjectsTool } from "./tools/list-projects.js";
import { registerListTasksTool } from "./tools/list-tasks.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new VikunjaClient(config);
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

  // TODO: register write tools (create/update/complete/comment/delete_task) as their own group.
  //       See CLAUDE.md -> "Tool surface". Each tool lives in src/tools/*.

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`vikunja-mcp ready (host: ${config.baseUrl})\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
