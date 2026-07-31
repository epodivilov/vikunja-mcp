#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VikunjaClient, resolvePageSize } from "./client.ts";
import { loadConfig } from "./config.ts";
import { registerAllTools } from "./register-tools.ts";
import { Resolver } from "./resolver.ts";

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
  // a tool has to keep, and nothing here needs to wrap them. The registration list itself lives
  // in register-tools.ts, where a test can drive it against a stub server.
  registerAllTools(server, client, resolver);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`vikunja-mcp ready (host: ${config.baseUrl})\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
