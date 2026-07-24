/**
 * `vikunja_get_task` — one task in full, addressed the way the UI addresses it.
 *
 * The key -> id resolution lives in the resolver; this file decides only which of the two
 * inputs was given. A bare number in `ref` never becomes an id here: the resolver refuses it
 * and names the escape hatch, which is the whole point of addressing tasks by key.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import { relatedProjectIds, toLeanTaskDetail } from "../projection.js";
import type { Resolver } from "../resolver.js";
import type { RawTask } from "../types.js";
import { jsonResult } from "./result.js";

export function registerGetTaskTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_get_task",
    {
      title: "Get task",
      description:
        "Reads one task, including its description as markdown and its related tasks — what " +
        "blocks it, what it blocks, its subtasks and so on, each named by key. Address it by " +
        "key — `ref`, e.g. INFRA-41, exactly as task listings report it. `id` is an escape " +
        "hatch for the cases a key cannot name: a project with no key, an archived project, or " +
        "a key two projects claim.",
      inputSchema: {
        ref: z
          .string()
          .min(1)
          .optional()
          .describe("Task key, e.g. INFRA-41 — the `ref` field of vikunja_list_tasks."),
        id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Global task id. Escape hatch; prefer `ref`."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ref, id }) => {
      const task = await read(client, resolver, ref, id);

      // Related tasks arrive with an empty `identifier` and may sit in other projects, so their
      // keys are rebuilt from the resolver's project index. A task with no relations asks for
      // nothing and the lookup costs no request.
      const refOf = await resolver.taskRefLookup(relatedProjectIds(task));

      return jsonResult(toLeanTaskDetail(task, refOf));
    },
  );
}

function read(
  client: VikunjaClient,
  resolver: Resolver,
  ref: string | undefined,
  id: number | undefined,
): Promise<RawTask> {
  if (ref !== undefined && id !== undefined) {
    throw new Error("Pass either ref (a key such as INFRA-41) or id (a global id), not both.");
  }

  if (id !== undefined) {
    return client.getTask(id);
  }

  if (ref === undefined) {
    throw new Error(
      'A task key is required, e.g. { ref: "INFRA-41" }. If you only have the global id, pass it as { id: <number> }.',
    );
  }

  return resolver.resolveTask(ref);
}
