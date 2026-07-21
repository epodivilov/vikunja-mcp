#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const server = new McpServer({
    name: "vikunja",
    version: "0.0.0",
  });

  // TODO: register read tools (list_projects, list_tasks, get_task, list_labels)
  //       and write tools (create/update/complete/comment/delete_task).
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
