/**
 * `vikunja_create_tasks` — create many tasks in one project in a single call.
 *
 * Vikunja has no native bulk-create endpoint, so this is genuine value above the API rather than a
 * thin wrapper: it batches name resolution and returns one consolidated outcome instead of costing
 * one round-trip per task and leaving the agent to stitch N results together.
 *
 * Unlike every other write tool here, this one does NOT throw on a per-item write failure — it
 * returns the failures in `failed`, with the input position of each. The throw path is reserved for
 * phase-1 validation: a bad project/label/assignee name, or an empty batch, fails the whole call
 * with nothing written. The whole body — resolve-then-create — lives in `applyBulkCreate` in a
 * module the test suite can load; this file is the schema, the annotations and one call.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.ts";
import { toLeanTask, toTaskWrite } from "../projection.ts";
import type { Resolver } from "../resolver.ts";
import { jsonResult } from "./result.ts";
import { dueField, priorityField } from "./task-fields.ts";
import { applyBulkCreate } from "./task-target.ts";
import { usersField } from "./user-fields.ts";

export function registerCreateTasksTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_create_tasks",
    {
      title: "Create tasks",
      description:
        "Create several tasks in one project in a single call — for scaffolding a decomposition " +
        "without one round-trip per task. Every task lands in the one project named here. Answers " +
        "with { created, failed }: `created` holds the tasks that were made as lean rows, `failed` " +
        "holds the specs that could not be, each as { index, error } where `index` is the task's " +
        "0-based position in the input. An unknown or ambiguous project, label or assignee name " +
        "fails the whole call and creates nothing; a per-task write failure during creation does " +
        "not — it is reported in `failed` while the other tasks are still created. Create is not " +
        "atomic (Vikunja has no bulk-create endpoint), so a task may be created and then fail to be " +
        "labelled; that failure names the created task's id.",
      // Strict, like vikunja_create_task: a misspelled argument — on the call or on a task — is
      // refused rather than silently dropped, at both levels.
      inputSchema: z.strictObject({
        project: z
          .string()
          .optional()
          .describe(
            'Project key, e.g. "INFRA" — the one project every task in this call is created in.',
          ),
        projectId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Global project id. Escape hatch for a project that has no key; prefer `project`.",
          ),
        tasks: z
          .array(
            z.strictObject({
              title: z.string().trim().min(1).describe("Task title, as a single line."),
              description: z
                .string()
                .optional()
                .describe(
                  "Task body in markdown. Vikunja stores HTML and converts nothing itself, so the conversion happens here — send markdown, not HTML.",
                ),
              priority: priorityField
                .optional()
                .describe("0 none, 1 low, 2 medium, 3 high, 4 urgent, 5 DO NOW."),
              due: dueField
                .optional()
                .describe('Due date as an RFC3339 timestamp, "2026-07-25T09:00:00Z".'),
              labels: z
                .array(z.union([z.string(), z.number().int().positive()]))
                .optional()
                .describe(
                  "Existing labels, each named by title or by the id vikunja_list_labels reports. Labels are never created here; an unknown one fails the whole call. Pass an id when a title turns out to be shared.",
                ),
              assignees: usersField
                .optional()
                .describe(
                  "Users to assign this task to, each by the username vikunja_list_members reports, or by global id. An unknown or ambiguous name fails the whole call before anything is created.",
                ),
            }),
          )
          .min(1)
          .describe("The tasks to create, in order. At least one."),
      }),
      // Not destructive: it only adds tasks and touches nothing that exists.
      annotations: { destructiveHint: false },
    },
    async ({ project, projectId, tasks }) =>
      jsonResult(
        await applyBulkCreate(
          client,
          resolver,
          { project, projectId },
          tasks,
          toTaskWrite,
          toLeanTask,
        ),
      ),
  );
}
