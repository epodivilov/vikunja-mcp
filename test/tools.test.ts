/**
 * The tool layer's glue, now that relative `.ts` import specifiers let `node --test` load a file
 * under `src/tools/` that value-imports a sibling (VMCP-31). Before that change these modules were
 * unreachable from a test: they write `.js` value specifiers the type-stripping loader will not
 * resolve to `.ts`, so importing one failed with `ERR_MODULE_NOT_FOUND`.
 *
 * What is proved here is the glue a tool file owns and nothing below it can: that the entry point
 * registers exactly the documented surface, that each registration's annotations match its kind
 * (read vs. write), and the two refusals that live only in a tool file — get_task's both/neither
 * argument guard and move_task's filter-board refusal.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { VikunjaClient } from "../src/client.ts";
import { registerAllTools } from "../src/register-tools.ts";
import type { Resolver } from "../src/resolver.ts";
import { registerGetTaskTool } from "../src/tools/get-task.ts";
import { registerMoveTaskTool } from "../src/tools/move-task.ts";
import type { RawTask } from "../src/types.ts";

/** The 8 read tools of the CLAUDE.md surface table, each carrying `readOnlyHint`. */
const READ_TOOLS = [
  "vikunja_list_projects",
  "vikunja_list_tasks",
  "vikunja_get_task",
  "vikunja_list_labels",
  "vikunja_get_board",
  "vikunja_list_members",
  "vikunja_list_comments",
  "vikunja_get_comment",
];

/** The 18 write tools of the same table, none of which may carry `readOnlyHint`. */
const WRITE_TOOLS = [
  "vikunja_create_task",
  "vikunja_update_task",
  "vikunja_bulk_update_tasks",
  "vikunja_complete_task",
  "vikunja_comment_task",
  "vikunja_update_comment",
  "vikunja_move_task",
  "vikunja_label_task",
  "vikunja_set_task_labels",
  "vikunja_create_label",
  "vikunja_update_label",
  "vikunja_assign_task",
  "vikunja_unassign_task",
  "vikunja_relate_tasks",
  "vikunja_unrelate_tasks",
  "vikunja_delete_task",
  "vikunja_delete_comment",
  "vikunja_delete_label",
];

/** Every tool the surface table names, and nothing else. */
const SURFACE_TABLE = [...READ_TOOLS, ...WRITE_TOOLS];

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

interface ToolAnnotations {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  idempotentHint?: unknown;
  openWorldHint?: unknown;
}

interface RecordedTool {
  name: string;
  config: { annotations?: ToolAnnotations };
  handler: ToolHandler;
}

/**
 * A stand-in for `McpServer` that records what `registerTool` is handed and does nothing else —
 * the real SDK only stores the handler at registration, so a call to this dials nothing out.
 */
function recordingServer(): { server: McpServer; tools: Map<string, RecordedTool> } {
  const tools = new Map<string, RecordedTool>();
  const registerTool = (
    name: string,
    config: RecordedTool["config"],
    handler: ToolHandler,
  ): void => {
    tools.set(name, { name, config, handler });
  };
  return { server: { registerTool } as unknown as McpServer, tools };
}

/**
 * A client/resolver stand-in that throws on any property access, so a registration that touched
 * one — i.e. tried to dial out — would fail loudly rather than pass silently.
 */
function forbidden(label: string): never {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`${label}.${String(property)} must not be touched during registration`);
      },
    },
  ) as never;
}

/** Run the whole registration list against a recording server and hand back what it captured. */
function registerAll(): Map<string, RecordedTool> {
  const { server, tools } = recordingServer();
  registerAllTools(server, forbidden("client"), forbidden("resolver"));
  return tools;
}

/** A minimal task row of the shape both read paths return, enough for `toLeanTask`. */
function rawTask(id: number, projectId: number, index: number, identifier: string): RawTask {
  return {
    id,
    project_id: projectId,
    index,
    identifier,
    title: `Task ${id}`,
    description: "",
    done: false,
    priority: 0,
    due_date: "0001-01-01T00:00:00Z",
    labels: null,
    assignees: null,
  };
}

/** Register a single tool on a fresh recording server and return its captured handler. */
function handlerOf(
  register: (server: McpServer, client: VikunjaClient, resolver: Resolver) => void,
  name: string,
  client: unknown,
  resolver: unknown,
): ToolHandler {
  const { server, tools } = recordingServer();
  register(server, client as VikunjaClient, resolver as Resolver);
  const tool = tools.get(name);
  assert.ok(tool, `${name} was registered`);
  return tool.handler;
}

describe("R1: the tool modules load under node --test", () => {
  it("imports src/tools/get-task.ts and src/tools/move-task.ts without ERR_MODULE_NOT_FOUND", () => {
    // Reaching this line at all is the proof: both modules value-import ../projection, and the
    // top-of-file imports above would have thrown before any test ran if they could not resolve.
    assert.equal(typeof registerGetTaskTool, "function");
    assert.equal(typeof registerMoveTaskTool, "function");
    assert.equal(typeof registerAllTools, "function");
  });
});

describe("R3: the registration list", () => {
  it("registers exactly 26 tools and makes no network request", () => {
    const tools = registerAll();
    assert.equal(tools.size, 26);
  });

  it("registers exactly the tools named in the CLAUDE.md surface table, and nothing else", () => {
    const tools = registerAll();
    assert.deepEqual([...tools.keys()].sort(), [...SURFACE_TABLE].sort());
  });
});

describe("R4: annotations match the tool's kind", () => {
  it("every read tool declares readOnlyHint: true", () => {
    const tools = registerAll();
    for (const name of READ_TOOLS) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} was registered`);
      assert.equal(tool.config.annotations?.readOnlyHint, true, `${name} declares readOnlyHint`);
    }
  });

  it("every write tool has an annotations block, no readOnlyHint, and an explicit destructiveHint", () => {
    const tools = registerAll();
    for (const name of WRITE_TOOLS) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} was registered`);
      const annotations = tool.config.annotations;
      assert.ok(annotations, `${name} has an annotations block`);
      assert.ok(!("readOnlyHint" in annotations), `${name} omits readOnlyHint`);
      assert.equal(
        typeof annotations.destructiveHint,
        "boolean",
        `${name} declares destructiveHint as a boolean`,
      );
    }
  });

  it("update_task and bulk_update_tasks declare destructiveHint: true", () => {
    const tools = registerAll();
    for (const name of ["vikunja_update_task", "vikunja_bulk_update_tasks"]) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} was registered`);
      assert.equal(tool.config.annotations?.destructiveHint, true, `${name} is destructive`);
    }
  });
});

describe("R5: get_task's target guard", () => {
  it("refuses both ref and id, naming 'not both', without touching either stub", async () => {
    const handler = handlerOf(
      registerGetTaskTool,
      "vikunja_get_task",
      forbidden("client"),
      forbidden("resolver"),
    );
    await assert.rejects(
      () => handler({ ref: "INFRA-1", id: 5 }),
      (error: Error) =>
        /either ref/.test(error.message) &&
        /\bid\b/.test(error.message) &&
        /not both/.test(error.message),
    );
  });

  it("refuses neither ref nor id, naming the { id: <number> } escape hatch", async () => {
    const handler = handlerOf(
      registerGetTaskTool,
      "vikunja_get_task",
      forbidden("client"),
      forbidden("resolver"),
    );
    await assert.rejects(() => handler({}), /\{ id: <number> \}/);
  });
});

describe("R6: move_task's board-mode guard", () => {
  it("refuses a filter-mode board, naming vikunja_label_task, and never moves the task", async () => {
    let moveCalls = 0;
    const client = {
      getTask: async (): Promise<RawTask> => {
        throw new Error("client.getTask must not be reached on the key path");
      },
      moveTask: async (): Promise<void> => {
        moveCalls += 1;
      },
    };
    const resolver = {
      resolveTask: async (): Promise<RawTask> => rawTask(530, 3, 1, "INFRA-1"),
      resolveKanbanView: async (): Promise<{ id: number; mode: string }> => ({
        id: 44,
        mode: "filter",
      }),
      resolveBucketId: async (): Promise<number> => {
        throw new Error("resolver.resolveBucketId must not be reached on a filter board");
      },
    };

    const handler = handlerOf(registerMoveTaskTool, "vikunja_move_task", client, resolver);

    await assert.rejects(() => handler({ task: "INFRA-1", column: "Doing" }), /vikunja_label_task/);
    assert.equal(moveCalls, 0, "nothing was moved");
  });

  it("moves once with the resolved bucket and reads the task back on a manual board", async () => {
    const moves: Array<{ projectId: number; viewId: number; bucketId: number; taskId: number }> =
      [];
    const reads: number[] = [];
    const afterMove = rawTask(530, 3, 1, "INFRA-1");

    const client = {
      moveTask: async (
        projectId: number,
        viewId: number,
        bucketId: number,
        taskId: number,
      ): Promise<void> => {
        moves.push({ projectId, viewId, bucketId, taskId });
      },
      getTask: async (id: number): Promise<RawTask> => {
        reads.push(id);
        return afterMove;
      },
    };
    const resolver = {
      resolveTask: async (): Promise<RawTask> => rawTask(530, 3, 1, "INFRA-1"),
      resolveKanbanView: async (): Promise<{ id: number; mode: string }> => ({
        id: 12,
        mode: "manual",
      }),
      resolveBucketId: async (): Promise<number> => 8,
    };

    const handler = handlerOf(registerMoveTaskTool, "vikunja_move_task", client, resolver);
    const result = await handler({ task: "INFRA-1", column: "Doing" });

    assert.deepEqual(moves, [{ projectId: 3, viewId: 12, bucketId: 8, taskId: 530 }]);
    assert.deepEqual(reads, [530], "read the task back after moving it");

    const [block] = result.content;
    if (block?.type !== "text") throw new Error("expected a single text content block");
    const payload = JSON.parse(block.text) as { ref: string };
    assert.equal(payload.ref, "INFRA-1");
  });
});
