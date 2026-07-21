/**
 * `vikunja_create_task` — the one write that names a project rather than a task.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.js";
import { toLeanTask, toTaskWrite } from "../projection.js";
import type { Resolver } from "../resolver.js";
import { jsonResult } from "./result.js";
import { dueField, priorityField } from "./task-fields.js";

export function registerCreateTaskTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_create_task",
    {
      title: "Create task",
      description:
        "Create a task in a project. Answers with the new task's key, which is how every other tool addresses it.",
      // Strict: an argument this schema does not declare is an error rather than a silent
      // drop. `labels` on an update, `assignees` here, a misspelled field — a non-strict schema
      // answers all of them with a cheerful success and no change, which is the worst answer
      // available. The strictness also reaches the client as `additionalProperties: false`.
      inputSchema: z.strictObject({
        project: z
          .string()
          .optional()
          .describe('Project key, e.g. "INFRA" — the prefix of that project\'s task keys.'),
        projectId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Global project id. Escape hatch for a project that has no key; prefer `project`.",
          ),
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
            "Existing labels, each named by title or by the id vikunja_list_labels reports. Labels are never created here; an unknown one is an error. Pass an id when a title turns out to be shared.",
          ),
      }),
      annotations: { destructiveHint: false },
    },
    async ({ project, projectId, title, description, priority, due, labels }) => {
      const targetProject = await resolveProject(resolver, project, projectId);
      // Resolved before the task exists: an unknown or ambiguous label then fails with nothing
      // written, rather than leaving a task behind that is missing half its labels.
      const labelIds = labels === undefined ? [] : await resolver.resolveLabelIds(labels);

      const created = await client.createTask(
        targetProject,
        toTaskWrite({ title, description, priority, due }),
      );

      for (const labelId of labelIds) {
        try {
          await client.addTaskLabel(created.id, labelId);
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          throw new Error(
            `The task was created (id ${created.id}) but attaching label ${labelId} failed: ${reason}`,
            { cause },
          );
        }
      }

      // Read back rather than project the create response: that response carries the `labels`
      // array it was handed, which is neither what the server stored nor what the calls above
      // just attached. A read is the only answer that describes the task as it now is.
      const task = await client.getTask(created.id);

      return jsonResult(toLeanTask(task));
    },
  );
}

async function resolveProject(
  resolver: Resolver,
  key: string | undefined,
  id: number | undefined,
): Promise<number> {
  const trimmed = key?.trim();

  if (trimmed && id !== undefined) {
    throw new Error(
      `Pass either the project key ("${trimmed}") or { projectId: ${id} }, not both — they may name different projects.`,
    );
  }

  if (id !== undefined) {
    return id;
  }

  if (!trimmed) {
    throw new Error(
      'Which project? Pass its key, e.g. { project: "INFRA" }, or its id as { projectId: 3 }. List projects to see the keys in use.',
    );
  }

  return resolver.resolveProjectKey(trimmed);
}
