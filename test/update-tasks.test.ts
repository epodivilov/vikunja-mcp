/**
 * The heterogeneous-update data path, composed from the real `Resolver`, `VikunjaClient` and
 * projection — the exact layers `vikunja_update_tasks` wires together — over a single routing
 * `fetch`.
 *
 * The tool file's body is not restated here: `applyTaskUpdates` out of `src/tools/task-target.ts`
 * is the shipped code, and its only runtime import is zod. The tool file contributes just the
 * schema, and the one thing worth proving there — that `z.strictObject` refuses a per-item `labels`
 * or `assignees` — is driven through the schema the tool actually registers (`updateItemSchema`),
 * not a copy of it.
 *
 * The stub server mirrors what 2.3.0 was probed doing: `POST /tasks/{id}` is a whole-struct write,
 * so the client sends the stored task back with the patch layered on, and the read-back is the only
 * honest answer. Each item carries its OWN patch, and the same task may not be targeted twice.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VikunjaClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { toLeanTask, toTaskWrite } from "../src/projection.ts";
import { Resolver } from "../src/resolver.ts";
import { type UpdateTaskSpec, applyTaskUpdates } from "../src/tools/task-target.ts";
import { updateItemSchema } from "../src/tools/update-tasks.ts";
import type { RawProject, RawTask, UpdatedTasks } from "../src/types.ts";

const config: Config = { baseUrl: "http://vikunja.test/api/v1", token: "t0ken" };

const ZERO_DATE = "0001-01-01T00:00:00Z";

interface RecordedCall {
  method: string;
  path: string;
  /** The decoded `filter` query parameter, or null when the request carried none. */
  filter: string | null;
  body: unknown;
}

const PREFIX: Record<number, string> = { 11: "VMCP", 7: "INFRA", 14: "OLD" };

function task(id: number, projectId: number, index: number, overrides: Partial<RawTask> = {}) {
  const row: RawTask = {
    id,
    project_id: projectId,
    index,
    identifier: `${PREFIX[projectId]}-${index}`,
    title: `Task ${index}`,
    description: "<p>a body worth keeping</p>",
    done: false,
    priority: 3,
    due_date: ZERO_DATE,
    labels: null,
    assignees: null,
    reminders: null,
    is_favorite: false,
    repeat_after: 0,
    repeat_mode: 0,
    ...overrides,
  };
  return row;
}

/** The instance as every test starts with it. Cloned per stack, since an update mutates it. */
const TASKS: RawTask[] = [
  task(600, 11, 1),
  task(601, 11, 2),
  task(602, 11, 3),
  task(301, 7, 41),
  task(579, 14, 1),
];

interface StackOptions {
  /** Ids whose `POST /tasks/{id}` is rejected — an execution-phase write failure (R5). */
  rejectUpdateIds?: readonly number[];
  /** Adds a second project keyed `vmcp`, so a `VMCP-*` key resolves ambiguously (R2). */
  duplicateVmcp?: boolean;
}

interface Stack {
  client: VikunjaClient;
  resolver: Resolver;
  calls: RecordedCall[];
  store: RawTask[];
}

/** One routing fetch answering every endpoint the update flow touches, recording each request. */
function stack(options: StackOptions = {}): Stack {
  const calls: RecordedCall[] = [];
  const rejectUpdateIds = new Set(options.rejectUpdateIds ?? []);
  const store: RawTask[] = TASKS.map((row) => ({ ...row }));

  const projects: RawProject[] = [
    { id: 11, title: "vikunja-mcp", identifier: "VMCP", description: "", is_archived: false },
    { id: 7, title: "infra", identifier: "INFRA", description: "", is_archived: false },
    { id: 14, title: "retired", identifier: "OLD", description: "", is_archived: true },
  ];
  if (options.duplicateVmcp) {
    projects.push({
      id: 999,
      title: "dup",
      identifier: "vmcp",
      description: "",
      is_archived: false,
    });
  }

  const fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const rawBody = init?.body;
    const body: unknown = typeof rawBody === "string" ? JSON.parse(rawBody) : undefined;
    calls.push({ method, path, filter: url.searchParams.get("filter"), body });

    const json = (value: unknown, headers: Record<string, string> = {}): Response =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json", ...headers },
      });
    const listing = (items: unknown[]): Response =>
      json(items, { "x-pagination-total-pages": "1" });
    const failure = (status: number, code: number, message: string): Response =>
      new Response(JSON.stringify({ code, message }), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (method === "GET" && path === "/api/v1/projects") {
      return listing(projects);
    }

    if (method === "GET" && path === "/api/v1/tasks") {
      const filter = url.searchParams.get("filter") ?? "";
      const parsed = /^project_id = (\d+) && index (?:= (\d+)|in ([\d, ]+))$/.exec(filter);
      assert.ok(parsed, `the resolver wrote an unexpected filter: ${filter}`);

      const projectId = Number(parsed[1]);
      const indexes =
        parsed[2] === undefined
          ? (parsed[3] ?? "").split(",").map((part) => Number(part.trim()))
          : [Number(parsed[2])];

      // An archived project is absent from the `GET /tasks` collection whatever the filter says.
      if (projects.find((project) => project.id === projectId)?.is_archived === true) {
        return listing([]);
      }

      return listing(
        store.filter((row) => row.project_id === projectId && indexes.includes(row.index)),
      );
    }

    const one = /^\/api\/v1\/tasks\/(\d+)$/.exec(path);
    if (one) {
      const id = Number(one[1]);
      const row = store.find((candidate) => candidate.id === id);

      if (method === "GET") {
        // `GET /tasks/{id}` answers for an archived project's task, unlike the collection above.
        return row === undefined
          ? failure(404, 4002, "This task does not exist")
          : json({ ...row });
      }

      if (method === "POST") {
        assert.ok(row, `an update named a task the server does not have: ${id}`);
        if (rejectUpdateIds.has(id)) {
          return failure(400, 2004, `the server refused to update task ${id}`);
        }
        // `POST /tasks/{id}` is a whole-struct write: the client sends `{ ...current, ...patch }`,
        // so the stored row becomes exactly that. This is what preserves assignees and reminders.
        Object.assign(row, body);
        return json({ ...row });
      }
    }

    throw new Error(`unrouted ${method} ${path}`);
  }) as typeof globalThis.fetch;

  const client = new VikunjaClient(config, { fetch });
  return { client, resolver: new Resolver(client), calls, store };
}

/** The requests that touched a task, in order — the project listing is not part of the story. */
function taskCalls(calls: readonly RecordedCall[]): string[] {
  return calls
    .filter((call) => call.path !== "/api/v1/projects")
    .map((call) => `${call.method} ${call.path}`);
}

/** Whether any write — a `POST /tasks/{id}` — was issued at all. */
function wroteAnything(calls: readonly RecordedCall[]): boolean {
  return calls.some((call) => call.method === "POST" && /^\/api\/v1\/tasks\/\d+$/.test(call.path));
}

/** The shipped tool body, with the two projection functions the tool itself passes in. */
function updateTasks(
  { client, resolver }: Stack,
  updates: readonly UpdateTaskSpec[],
): Promise<UpdatedTasks> {
  return applyTaskUpdates(client, resolver, updates, toTaskWrite, toLeanTask);
}

describe("update tasks — phase 1 (resolve/validate, all-or-nothing)", () => {
  it("R2: refuses an unknown key, writing nothing and naming it", async () => {
    const harness = stack();

    await assert.rejects(updateTasks(harness, [{ task: "VMCP-99", done: true }]), /VMCP-99/);
    assert.equal(wroteAnything(harness.calls), false, "nothing was written");
  });

  it("R2: refuses an ambiguous key, writing nothing and naming it", async () => {
    const harness = stack({ duplicateVmcp: true });

    await assert.rejects(updateTasks(harness, [{ task: "VMCP-1", done: true }]), /ambiguous/i);
    assert.equal(wroteAnything(harness.calls), false, "nothing was written");
  });

  it("R2: refuses a key in an archived project, writing nothing", async () => {
    const harness = stack();

    await assert.rejects(updateTasks(harness, [{ task: "OLD-1", done: true }]), /archived/i);
    assert.equal(wroteAnything(harness.calls), false, "nothing was written");
  });

  it("R2: refuses a nonexistent id, writing nothing", async () => {
    const harness = stack();

    await assert.rejects(updateTasks(harness, [{ id: 999999, done: true }]));
    assert.equal(wroteAnything(harness.calls), false, "nothing was written");
  });

  it("R2: resolves every item before the first write — a bad name in item 2 leaves item 1 unwritten", async () => {
    const harness = stack();

    await assert.rejects(
      updateTasks(harness, [
        { task: "VMCP-1", done: true },
        { task: "VMCP-99", priority: 5 },
      ]),
      /VMCP-99/,
    );
    assert.equal(
      wroteAnything(harness.calls),
      false,
      "not even the resolvable first item was written",
    );
  });

  it("R3: refuses an empty updates array, issuing no request at all", async () => {
    const harness = stack();

    await assert.rejects(updateTasks(harness, []), /update/i);
    assert.equal(harness.calls.length, 0, "nothing was even resolved");
  });

  it("R3: refuses an item that names no field to change, before any request", async () => {
    const harness = stack();

    await assert.rejects(updateTasks(harness, [{ task: "VMCP-1" }]), /nothing/i);
    assert.equal(harness.calls.length, 0, "nothing was resolved and nothing was written");
  });

  it("R3: refuses the same task targeted twice, writing nothing", async () => {
    const harness = stack();

    await assert.rejects(
      updateTasks(harness, [
        { task: "VMCP-1", done: true },
        { task: "VMCP-1", priority: 5 },
      ]),
      /VMCP-1/,
    );
    assert.equal(wroteAnything(harness.calls), false, "nothing was written");
  });

  it("R3: refuses a key and the id of the same task in one call", async () => {
    const harness = stack();

    // VMCP-1 is id 600; naming both is one task twice, an order-dependent conflict.
    await assert.rejects(
      updateTasks(harness, [
        { task: "VMCP-1", done: true },
        { id: 600, priority: 5 },
      ]),
    );
    assert.equal(wroteAnything(harness.calls), false, "nothing was written");
  });
});

describe("update tasks — schema (per-item strictness)", () => {
  it("R4: rejects an item carrying labels at the strict-schema level", () => {
    assert.equal(updateItemSchema.safeParse({ task: "VMCP-1", labels: ["bug"] }).success, false);
  });

  it("R4: rejects an item carrying assignees at the strict-schema level", () => {
    assert.equal(
      updateItemSchema.safeParse({ task: "VMCP-1", assignees: ["alice"] }).success,
      false,
    );
  });

  it("R4: accepts an item carrying only recognised fields", () => {
    assert.equal(updateItemSchema.safeParse({ task: "VMCP-1", done: true }).success, true);
  });
});

describe("update tasks — phase 2 (execute, best-effort)", () => {
  it("R1: applies each item's own patch and returns each updated task as a lean row", async () => {
    const harness = stack();

    const answer = await updateTasks(harness, [
      { task: "VMCP-1", title: "Renamed one" },
      { task: "VMCP-2", priority: 5 },
    ]);

    assert.deepEqual(
      answer.updated.map((row) => row.ref),
      ["VMCP-1", "VMCP-2"],
    );
    assert.equal(answer.updated[0]?.title, "Renamed one");
    assert.equal(answer.updated[1]?.priority, 5);
    assert.deepEqual(answer.failed, []);

    // Each patch landed on its own task and nowhere else.
    const first = harness.store.find((row) => row.id === 600);
    const second = harness.store.find((row) => row.id === 601);
    assert.equal(first?.title, "Renamed one");
    assert.equal(first?.priority, 3, "the title patch did not touch VMCP-1's priority");
    assert.equal(second?.priority, 5);
    assert.equal(second?.title, "Task 2", "the priority patch did not touch VMCP-2's title");
  });

  it("R5: a rejected update in the middle neither stops the rest nor throws", async () => {
    const harness = stack({ rejectUpdateIds: [601] });

    const answer = await updateTasks(harness, [
      { task: "VMCP-1", done: true },
      { task: "VMCP-2", done: true },
      { task: "VMCP-3", done: true },
    ]);

    assert.deepEqual(
      answer.updated.map((row) => row.ref),
      ["VMCP-1", "VMCP-3"],
      "the first and third were still updated",
    );
    assert.equal(answer.failed.length, 1);
    assert.equal(answer.failed[0]?.index, 1, "the failure carries the input position");
    assert.match(answer.failed[0]?.error ?? "", /601|refused/);
  });

  it("R6: a { done } patch preserves the task's assignees and reminders via read-modify-write", async () => {
    const harness = stack();
    const target = harness.store.find((row) => row.id === 600);
    assert.ok(target);
    target.assignees = [{ id: 3, username: "alice", name: "" }];
    target.reminders = [{ reminder: "2026-08-01T09:00:00Z" }];

    await updateTasks(harness, [{ task: "VMCP-1", done: true }]);

    // The single-column POST would strip these; the read-modify-write carries them back verbatim.
    const post = harness.calls.find(
      (call) => call.method === "POST" && call.path === "/api/v1/tasks/600",
    );
    assert.ok(post, "an update was posted for VMCP-1");
    const sent = post.body as {
      done?: boolean;
      assignees?: unknown[];
      reminders?: unknown[];
      description?: string;
    };
    assert.equal(sent.done, true);
    assert.equal(sent.assignees?.length, 1, "the assignee rode along in the write");
    assert.equal(sent.reminders?.length, 1, "the reminder rode along in the write");
    assert.equal(sent.description, "<p>a body worth keeping</p>", "and the description was kept");
  });

  it("R1: reads, writes, then reads back for each task", async () => {
    const harness = stack();

    await updateTasks(harness, [{ id: 602, done: true }]);

    // The id path: read to resolve, read-modify-write (read + post), read back.
    assert.deepEqual(taskCalls(harness.calls), [
      "GET /api/v1/tasks/602",
      "GET /api/v1/tasks/602",
      "POST /api/v1/tasks/602",
      "GET /api/v1/tasks/602",
    ]);
  });
});
