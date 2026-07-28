/**
 * The bulk-update data path, composed from the real `Resolver`, `VikunjaClient` and projection —
 * the exact layers `vikunja_bulk_update_tasks` wires together — over a single routing `fetch`.
 *
 * The tool file itself is not imported, and cannot be: `src/tools/bulk-update-tasks.ts` carries
 * `.js` value specifiers the type-stripping loader will not resolve to `.ts`. What IS imported for
 * real is everything it delegates to — `resolveBulkTargets`, `findBulkBlockers` and
 * `applyBulkUpdate` out of `src/tools/task-target.ts`, whose only runtime import is zod. The tool's
 * whole body lives there precisely so the ordering below can be proved: resolve, then vet, *then*
 * write. A test that restated that body would prove only that the transcription still works.
 *
 * The stub server mirrors what 2.3.0 was probed doing: it accepts `index in 24, 25, 26` as one
 * quoted value, answers an archived project's task collection with `[]` whatever the filter says,
 * applies a bulk write to the named columns only, and echoes the request struct back rather than
 * the stored tasks.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VikunjaClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { toLeanTask, toTaskWrite } from "../src/projection.ts";
import { Resolver } from "../src/resolver.ts";
import {
  type BulkTaskTarget,
  applyBulkUpdate,
  findBulkBlockers,
  resolveBulkTargets,
} from "../src/tools/task-target.ts";
import type { LeanTask, RawProject, RawTask } from "../src/types.ts";

const config: Config = { baseUrl: "http://vikunja.test/api/v1", token: "t0ken" };

const ZERO_DATE = "0001-01-01T00:00:00Z";

interface RecordedCall {
  method: string;
  path: string;
  /** The decoded `filter` query parameter, or null when the request carried none. */
  filter: string | null;
  body: unknown;
}

const PROJECTS: RawProject[] = [
  { id: 11, title: "vikunja-mcp", identifier: "VMCP", description: "", is_archived: false },
  { id: 7, title: "infra", identifier: "INFRA", description: "", is_archived: false },
  { id: 14, title: "retired", identifier: "OLD", description: "", is_archived: true },
];

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
    // Both read paths always send these, as zero values on a task that does not repeat — probed
    // live on 2.3.0. The check fails closed on their absence, so a fixture that omitted them
    // would block every task and prove nothing.
    repeat_after: 0,
    repeat_mode: 0,
    ...overrides,
  };
  return row;
}

/** The instance as every test starts with it. Cloned per stack, since a bulk write mutates it. */
const TASKS: RawTask[] = [
  task(600, 11, 1),
  task(601, 11, 2),
  task(617, 11, 24),
  task(618, 11, 25),
  task(619, 11, 26),
  task(301, 7, 41),
  task(579, 14, 1),
];

interface StackOptions {
  /** False emulates a server that drops the `index` term and answers with the whole project. */
  honoursIndex?: boolean;
  /** Ids of repeating tasks: Vikunja rolls them forward and hands them back open. */
  repeating?: readonly number[];
}

interface Stack {
  client: VikunjaClient;
  resolver: Resolver;
  calls: RecordedCall[];
  store: RawTask[];
}

/** One routing fetch answering every endpoint the bulk flow touches, recording each request. */
function stack(options: StackOptions = {}): Stack {
  const calls: RecordedCall[] = [];
  const repeating = options.repeating ?? [];
  const store: RawTask[] = TASKS.map((row) =>
    repeating.includes(row.id) ? { ...row, repeat_after: 86400 } : { ...row },
  );

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
      return listing(PROJECTS);
    }

    if (method === "GET" && path === "/api/v1/tasks") {
      const filter = url.searchParams.get("filter") ?? "";
      // Both spellings the resolver may write: one index reads `= n`, several read `in a, b, c`.
      const parsed = /^project_id = (\d+) && index (?:= (\d+)|in ([\d, ]+))$/.exec(filter);
      assert.ok(parsed, `the resolver wrote an unexpected filter: ${filter}`);

      const projectId = Number(parsed[1]);
      const indexes =
        parsed[2] === undefined
          ? (parsed[3] ?? "").split(",").map((part) => Number(part.trim()))
          : [Number(parsed[2])];

      // An archived project is absent from the `GET /tasks` collection no matter what the
      // filter says — the handler builds its project set with `getArchived` false.
      if (PROJECTS.find((project) => project.id === projectId)?.is_archived === true) {
        return listing([]);
      }

      return listing(
        store.filter(
          (row) =>
            row.project_id === projectId &&
            (options.honoursIndex === false || indexes.includes(row.index)),
        ),
      );
    }

    const one = /^\/api\/v1\/tasks\/(\d+)$/.exec(path);
    if (method === "GET" && one) {
      const found = store.find((row) => row.id === Number(one[1]));
      // `GET /tasks/{id}` answers for an archived project's task, unlike the collection above.
      return found === undefined
        ? failure(404, 4002, "This task does not exist")
        : json({ ...found });
    }

    if (method === "POST" && path === "/api/v1/tasks/bulk") {
      const payload = body as {
        task_ids: number[];
        fields: string[];
        values: Record<string, unknown>;
      };

      for (const id of payload.task_ids) {
        const row = store.find((candidate) => candidate.id === id);
        assert.ok(row, `the bulk write named a task the server does not have: ${id}`);

        // Only the named columns are written; every other one is restored from the stored row.
        for (const field of payload.fields) {
          (row as unknown as Record<string, unknown>)[field] = payload.values[field];
        }

        // A repeating task does not end up done — and, on this endpoint, does not end up rolled
        // forward either. Probed on 2.3.0: the 200 body carries the new dates, but only the
        // columns named in `fields` are persisted, so the roll is discarded and the task is left
        // open with its old due date. That is what this stub reproduces; simulating the roll
        // would be a stub asserting something the server does not do.
        if (repeating.includes(id) && payload.fields.includes("done")) {
          row.done = false;
        }
      }

      // The handler renders the BulkTask struct back, not the stored tasks. Nobody may read it.
      return json(payload);
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

/** The `filter` of every task-collection read, in order. */
function filters(calls: readonly RecordedCall[]): string[] {
  return calls
    .filter((call) => call.path === "/api/v1/tasks")
    .map((call) => call.filter ?? "(none)");
}

/** The one bulk write that was issued, or a failed assertion. */
function bulkWrite(calls: readonly RecordedCall[]): {
  task_ids: number[];
  fields: string[];
  values: Record<string, unknown>;
} {
  const writes = calls.filter((call) => call.path === "/api/v1/tasks/bulk");
  assert.equal(writes.length, 1, "expected exactly one bulk write");
  const [write] = writes;
  assert.ok(write);
  return write.body as { task_ids: number[]; fields: string[]; values: Record<string, unknown> };
}

/** The shipped tool body, with the two projection functions the tool itself passes in. */
function bulkUpdate(
  { client, resolver }: Stack,
  target: BulkTaskTarget,
  fields: { done?: boolean; priority?: number; due?: string },
): Promise<LeanTask[]> {
  return applyBulkUpdate(client, resolver, target, fields, toTaskWrite, toLeanTask);
}

describe("batch key resolution", () => {
  it("R3: resolves several keys of one project in one request, with an `index in` filter", async () => {
    const harness = stack();

    const tasks = await harness.resolver.resolveTasks(["VMCP-24", "VMCP-25", "VMCP-26"]);

    assert.deepEqual(filters(harness.calls), ["project_id = 11 && index in 24, 25, 26"]);
    assert.deepEqual(
      tasks.map((row) => row.id),
      [617, 618, 619],
    );
  });

  it("R3: keeps one request per project, neither carrying the other's indexes", async () => {
    const harness = stack();

    const tasks = await harness.resolver.resolveTasks(["VMCP-24", "INFRA-41", "VMCP-25"]);

    assert.deepEqual(filters(harness.calls), [
      "project_id = 11 && index in 24, 25",
      "project_id = 7 && index = 41",
    ]);
    assert.deepEqual(
      tasks.map((row) => row.id),
      [617, 301, 618],
      "answered in the order the keys were named, not in the order they were fetched",
    );
  });

  it("R3: matches each key on its own index and project, never by row order", async () => {
    // A server that ignored the `index` term answers with the project's whole task list, and
    // zipping that against the requested keys by position assigns the wrong task to every key.
    const harness = stack({ honoursIndex: false });

    const tasks = await harness.resolver.resolveTasks(["VMCP-26", "VMCP-24"]);

    assert.deepEqual(
      tasks.map((row) => row.index),
      [26, 24],
    );
  });

  it("R3: names the key whose index does not exist, and writes nothing", async () => {
    const harness = stack();

    await assert.rejects(
      harness.resolver.resolveTasks(["VMCP-24", "VMCP-99"]),
      /VMCP-99.*no task with index 99/s,
    );
    assert.equal(
      harness.calls.some((call) => call.path === "/api/v1/tasks/bulk"),
      false,
      "no write was issued",
    );
  });

  it("R3: tells the archived-project story `resolveTask` already tells", async () => {
    const harness = stack();

    await assert.rejects(harness.resolver.resolveTasks(["OLD-1"]), /archived/);
    // The single-key path says the same thing about the same project.
    await assert.rejects(harness.resolver.resolveTask("OLD-1"), /archived/);
  });

  it("R3: a key and an id naming the same task send one task id, once", async () => {
    const harness = stack();

    const tasks = await resolveBulkTargets(harness.client, harness.resolver, {
      tasks: ["VMCP-24"],
      ids: [617],
    });

    assert.deepEqual(
      tasks.map((row) => row.id),
      [617],
      "deduped by task id, first mention kept",
    );
    assert.ok(
      harness.calls.some((call) => call.path === "/api/v1/tasks/617" && call.method === "GET"),
      "the id escape hatch reads its own task, rather than being batched into a filter",
    );
  });

  it("R2: refuses a call naming no task at all, before any request", async () => {
    for (const target of [{}, { tasks: [], ids: [] }]) {
      const harness = stack();

      await assert.rejects(
        resolveBulkTargets(harness.client, harness.resolver, target),
        /Which tasks/,
      );
      assert.equal(harness.calls.length, 0, "nothing was requested");
    }
  });
});

describe("bulk blocker check", () => {
  it("R4: reports assignees, reminders and a favourite, each with its own reason", async () => {
    const blockers = findBulkBlockers(
      [
        task(617, 11, 24, { assignees: [{ id: 3, username: "alice", name: "" }] }),
        task(618, 11, 25, { reminders: [{ reminder: "2026-08-01T09:00:00Z" }] }),
        task(619, 11, 26, { is_favorite: true }),
        task(600, 11, 1, {
          assignees: [{ id: 3, username: "alice", name: "" }],
          reminders: [{ reminder: "2026-08-01T09:00:00Z" }],
          is_favorite: true,
        }),
        task(601, 11, 2),
      ],
      {},
    );

    assert.deepEqual(
      blockers.map((blocker) => blocker.ref),
      ["VMCP-24", "VMCP-25", "VMCP-26", "VMCP-1"],
      "the clean task is not reported",
    );
    assert.match(blockers[0]?.reasons.join(" ") ?? "", /assignee/i);
    assert.match(blockers[1]?.reasons.join(" ") ?? "", /reminder/i);
    assert.match(blockers[2]?.reasons.join(" ") ?? "", /favourite|favorite/i);
    assert.equal(blockers[3]?.reasons.length, 3, "a task carrying all three names all three");
  });

  it("R4: reports nothing for the empty shapes Vikunja actually sends", async () => {
    assert.deepEqual(
      findBulkBlockers(
        [
          task(617, 11, 24, { assignees: null, reminders: null, is_favorite: false }),
          task(618, 11, 25, { assignees: [], reminders: [], is_favorite: false }),
        ],
        {},
      ),
      [],
    );
  });

  it("R4: fails closed on a row that carries none of the three fields", async () => {
    // An absent field means the row did not come from a read that populates them, so "clean"
    // is not something this check may conclude — the guard would fail open on exactly the
    // path it exists to cover.
    const bare = {
      id: 617,
      project_id: 11,
      index: 24,
      identifier: "VMCP-24",
      title: "Task 24",
      description: "",
      done: false,
      priority: 0,
      due_date: ZERO_DATE,
      labels: null,
    } as unknown as RawTask;

    const blockers = findBulkBlockers([bare], {});

    assert.equal(blockers.length, 1);
    assert.equal(blockers[0]?.ref, "VMCP-24");
    assert.equal(
      blockers[0]?.reasons.length,
      3,
      "all three fields are unknown, so all three block",
    );
  });

  it("R4: blocks a repeating task when the patch sets done", () => {
    // The interval spelling, repeat_mode 0.
    const blockers = findBulkBlockers([task(617, 11, 24, { repeat_after: 86400 })], {
      done: true,
    });

    assert.equal(blockers.length, 1);
    assert.equal(blockers[0]?.repeats, true);
    assert.equal(blockers[0]?.destroys, false, "nothing would be destroyed on it");
    assert.match(blockers[0]?.reasons.join(" ") ?? "", /repeat/i);
  });

  it("R4: blocks a monthly-repeating task, whose repeat_after is 0", () => {
    // The trap: repeat_mode 1 repeats monthly and IGNORES repeat_after, so a check on the
    // interval alone would call this task non-repeating and let the silent no-op through.
    const blockers = findBulkBlockers([task(617, 11, 24, { repeat_mode: 1, repeat_after: 0 })], {
      done: true,
    });

    assert.equal(blockers.length, 1, "mode 1 repeats even with a zero interval");
    assert.equal(blockers[0]?.repeats, true);
  });

  it("R4: blocks repeat mode 2 — from today, by the interval", () => {
    // Mode 2 is `TaskRepeatModeFromCurrentDate` in the server's own enum. It still carries its
    // schedule in `repeat_after`, so this case is caught by the interval rather than by the mode;
    // the mode is here to pin that a non-default one is not treated as "not repeating".
    assert.equal(
      findBulkBlockers([task(617, 11, 24, { repeat_mode: 2, repeat_after: 3600 })], {
        done: true,
      }).length,
      1,
    );
  });

  it("R4: leaves a repeating task alone unless the patch actually completes it", () => {
    // The asymmetry with the other three: they are destroyed whatever is written, this one is
    // mishandled only on the not-done -> done transition, which is the only thing that makes the
    // server take its repeat branch. Refusing anything wider would be stricter than the server.
    const repeating = [
      task(617, 11, 24, { repeat_after: 86400 }),
      task(618, 11, 25, { repeat_mode: 1, repeat_after: 0 }),
    ];

    assert.deepEqual(findBulkBlockers(repeating, { priority: 4 }), []);
    assert.deepEqual(findBulkBlockers(repeating, { due: "2026-09-01T10:00:00Z" }), []);
    assert.deepEqual(
      findBulkBlockers(repeating, { done: false }),
      [],
      "a re-open is not a completion: probed on 2.3.0, a bulk done:false on a repeating task moved nothing",
    );
  });

  it("R4: leaves a repeating task alone when it is already done", () => {
    // No transition, so no repeat branch on the server — and refusing here would send the caller
    // to vikunja_complete_task to redo something already done.
    assert.deepEqual(
      findBulkBlockers([task(617, 11, 24, { repeat_after: 86400, done: true })], { done: true }),
      [],
    );
  });

  it("R4: fails closed on a row carrying neither repeat field, when done is set", () => {
    const { repeat_after, repeat_mode, ...row } = task(617, 11, 24);
    void repeat_after;
    void repeat_mode;

    const blockers = findBulkBlockers([row as RawTask], { done: true });

    assert.equal(blockers.length, 1, "unknown is not 'does not repeat'");
    assert.equal(blockers[0]?.repeats, true);
  });
});

describe("bulk update body", () => {
  it("R1: derives the field list from the patch's own keys, clears included", async () => {
    const harness = stack();

    await bulkUpdate(harness, { tasks: ["VMCP-24"] }, { priority: 0, due: "" });

    const write = bulkWrite(harness.calls);
    assert.deepEqual(write.fields, ["priority", "due_date"]);
    assert.deepEqual(write.values, { priority: 0, due_date: ZERO_DATE });
    assert.deepEqual(write.task_ids, [617]);
  });

  it("R2: refuses a call naming no field, before anything is resolved", async () => {
    const harness = stack();

    await assert.rejects(bulkUpdate(harness, { tasks: ["VMCP-24"] }, {}), /Nothing to update/);
    assert.equal(harness.calls.length, 0, "nothing was resolved and nothing was written");
  });

  it("R4: refuses the whole call for one blocked task among four", async () => {
    const harness = stack();
    const blocked = harness.store.find((row) => row.id === 618);
    assert.ok(blocked);
    blocked.assignees = [{ id: 3, username: "alice", name: "" }];

    await assert.rejects(
      bulkUpdate(harness, { tasks: ["VMCP-24", "VMCP-25", "VMCP-26", "INFRA-41"] }, { done: true }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /VMCP-25/);
        assert.match(error.message, /vikunja_update_task/);
        return true;
      },
    );
    assert.equal(
      harness.calls.some((call) => call.path === "/api/v1/tasks/bulk"),
      false,
      "nothing was written",
    );
    assert.equal(harness.store.find((row) => row.id === 617)?.done, false, "the set did not move");
  });

  it("R1/R6: reads, writes once, then reads back — and answers with lean rows", async () => {
    const harness = stack();

    const answer = await bulkUpdate(
      harness,
      { tasks: ["VMCP-24", "VMCP-25", "VMCP-26"] },
      { done: true },
    );

    assert.deepEqual(taskCalls(harness.calls), [
      "GET /api/v1/tasks",
      "POST /api/v1/tasks/bulk",
      "GET /api/v1/tasks",
    ]);
    assert.deepEqual(answer, [
      { ref: "VMCP-24", id: 617, title: "Task 24", done: true, priority: 3, labels: [] },
      { ref: "VMCP-25", id: 618, title: "Task 25", done: true, priority: 3, labels: [] },
      { ref: "VMCP-26", id: 619, title: "Task 26", done: true, priority: 3, labels: [] },
    ]);
    // The fields the call did not name are restored by the server from the stored row.
    assert.equal(
      harness.store.find((row) => row.id === 617)?.description,
      "<p>a body worth keeping</p>",
    );
  });

  it("R6: answers in the caller's order, with a twice-named task appearing once", async () => {
    const harness = stack();

    const answer = await bulkUpdate(
      harness,
      { tasks: ["VMCP-26", "VMCP-24", "VMCP-26"], ids: [617] },
      { done: true },
    );

    assert.deepEqual(
      answer.map((row) => row.ref),
      ["VMCP-26", "VMCP-24"],
      "first mention wins, and the duplicates collapse",
    );
    assert.deepEqual(bulkWrite(harness.calls).task_ids, [619, 617]);
  });

  it("R4: refuses the whole call when a repeating task is asked to be done", async () => {
    // A bulk completion does not stick on a repeating task — the endpoint discards the roll it
    // computes and leaves the task open with a done_at stamp. Refused rather than half-applied.
    const harness = stack({ repeating: [618] });

    await assert.rejects(
      () => bulkUpdate(harness, { tasks: ["VMCP-24", "VMCP-25"] }, { done: true }),
      (error: Error) => {
        assert.match(error.message, /VMCP-25/, "the repeating task is named");
        assert.doesNotMatch(error.message, /VMCP-24/, "the ordinary one is not");
        assert.match(error.message, /repeat/i);
        assert.match(error.message, /vikunja_complete_task/, "and the remedy is named");
        return true;
      },
    );

    assert.deepEqual(
      taskCalls(harness.calls).filter((call) => call.startsWith("POST")),
      [],
      "nothing was written",
    );
  });

  it("R1: still writes a repeating task when only its priority is set", async () => {
    // The conditional half of the refusal, end to end: no `done`, so no refusal, and the write
    // goes out. Without this the guard could be over-broad and every test would still pass.
    const harness = stack({ repeating: [618] });

    const answer = await bulkUpdate(harness, { tasks: ["VMCP-25"] }, { priority: 4 });

    assert.deepEqual(
      answer.map((row) => ({ ref: row.ref, priority: row.priority })),
      [{ ref: "VMCP-25", priority: 4 }],
    );
  });
});
