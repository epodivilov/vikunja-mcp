/**
 * The bulk-create data path, composed from the real `Resolver`, `VikunjaClient` and projection —
 * the exact layers `vikunja_create_tasks` wires together — over a single routing `fetch`.
 *
 * The tool file itself is not imported: `src/tools/create-tasks.ts` value-imports `../projection`
 * for the two functions it hands in. What IS imported for real is the whole body it delegates to —
 * `applyBulkCreate` out of `src/tools/task-target.ts`, whose only runtime import is zod. The tool's
 * body lives there precisely so the two-phase contract below can be proved: resolve every name
 * first (all-or-nothing), then create in input order collecting per-item outcomes (best-effort).
 *
 * The stub server mirrors what 2.3.0 was probed doing: a create (`PUT /projects/{p}/tasks`) never
 * stores labels and echoes assignees back as bare `{ id }` objects with no username, so only a
 * read-back (`GET /tasks/{id}`) reports what a task actually carries — which is why the tool reads
 * each created task back rather than projecting the create response.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VikunjaClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { toLeanTask, toTaskWrite } from "../src/projection.ts";
import { Resolver } from "../src/resolver.ts";
import {
  type CreateTaskSpec,
  type CreateTasksTarget,
  applyBulkCreate,
} from "../src/tools/task-target.ts";
import type { CreatedTasks, RawLabel, RawProject, RawUser } from "../src/types.ts";

const config: Config = { baseUrl: "http://vikunja.test/api/v1", token: "t0ken" };

const ZERO_DATE = "0001-01-01T00:00:00Z";

const PROJECTS: RawProject[] = [
  { id: 11, title: "vikunja-mcp", identifier: "VMCP", description: "", is_archived: false },
];

/** Two labels share the title "dup", so it is genuinely ambiguous; "nope" names none. */
const LABELS: RawLabel[] = [
  { id: 45, title: "bug", description: "", hex_color: "ff0000" },
  { id: 46, title: "dup", description: "", hex_color: "" },
  { id: 47, title: "dup", description: "", hex_color: "" },
];

const MEMBERS: RawUser[] = [
  { id: 3, username: "alice", name: "" },
  { id: 4, username: "bob", name: "" },
];

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

/** The server's canonical record of a task this call created — what a read-back is built from. */
interface StoredTask {
  id: number;
  index: number;
  title: string;
  description: string;
  priority: number;
  due_date: string;
  labelIds: number[];
  assigneeIds: number[];
}

interface StackOptions {
  /** Titles whose `PUT /projects/{p}/tasks` is rejected — an execution-phase create failure. */
  rejectCreateTitles?: readonly string[];
  /** Label ids whose `PUT /tasks/{id}/labels` is rejected — a created-but-unlabelled task. */
  rejectLabelIds?: readonly number[];
}

interface Stack {
  client: VikunjaClient;
  resolver: Resolver;
  calls: RecordedCall[];
  store: Map<number, StoredTask>;
}

/** One routing fetch answering every endpoint the create flow touches, recording each request. */
function stack(options: StackOptions = {}): Stack {
  const calls: RecordedCall[] = [];
  const store = new Map<number, StoredTask>();
  const rejectCreateTitles = new Set(options.rejectCreateTitles ?? []);
  const rejectLabelIds = new Set(options.rejectLabelIds ?? []);
  let nextId = 700;

  const fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const rawBody = init?.body;
    const body: unknown = typeof rawBody === "string" ? JSON.parse(rawBody) : undefined;
    calls.push({ method, path, body });

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
    if (method === "GET" && path === "/api/v1/labels") {
      return listing(LABELS);
    }
    if (method === "GET" && /^\/api\/v1\/projects\/\d+\/projectusers$/.test(path)) {
      return listing(MEMBERS);
    }

    const createMatch = /^\/api\/v1\/projects\/(\d+)\/tasks$/.exec(path);
    if (method === "PUT" && createMatch) {
      const payload = body as {
        title: string;
        description?: string;
        priority?: number;
        due_date?: string;
        assignees?: { id: number }[];
      };
      if (rejectCreateTitles.has(payload.title)) {
        return failure(400, 2004, `the server refused to create "${payload.title}"`);
      }
      const id = nextId++;
      const index = id - 699;
      store.set(id, {
        id,
        index,
        title: payload.title,
        description: payload.description ?? "",
        priority: payload.priority ?? 0,
        due_date: payload.due_date ?? ZERO_DATE,
        labelIds: [],
        assigneeIds: (payload.assignees ?? []).map((a) => a.id),
      });
      // A create never stores labels, and echoes assignees back as bare `{ id }` with an empty
      // username — exactly the response the tool must NOT project. Read-back is the answer.
      return json({
        id,
        project_id: Number(createMatch[1]),
        index,
        identifier: `VMCP-${index}`,
        title: payload.title,
        description: payload.description ?? "",
        done: false,
        priority: payload.priority ?? 0,
        due_date: payload.due_date ?? ZERO_DATE,
        labels: null,
        assignees: (payload.assignees ?? []).map((a) => ({ id: a.id, username: "", name: "" })),
      });
    }

    const labelMatch = /^\/api\/v1\/tasks\/(\d+)\/labels$/.exec(path);
    if (method === "PUT" && labelMatch) {
      const labelId = (body as { label_id: number }).label_id;
      if (rejectLabelIds.has(labelId)) {
        return failure(400, 8002, `label ${labelId} does not exist`);
      }
      const row = store.get(Number(labelMatch[1]));
      assert.ok(row, `a label was attached to a task the server never created: ${labelMatch[1]}`);
      row.labelIds.push(labelId);
      return json({});
    }

    const oneMatch = /^\/api\/v1\/tasks\/(\d+)$/.exec(path);
    if (method === "GET" && oneMatch) {
      const row = store.get(Number(oneMatch[1]));
      if (row === undefined) {
        return failure(404, 4002, "This task does not exist");
      }
      // The read-back reports what the task actually carries: labels joined from the link table,
      // assignees with their real usernames. This is what `toLeanTask` projects.
      return json({
        id: row.id,
        project_id: 11,
        index: row.index,
        identifier: `VMCP-${row.index}`,
        title: row.title,
        description: row.description,
        done: false,
        priority: row.priority,
        due_date: row.due_date,
        labels: row.labelIds.map((id) => LABELS.find((label) => label.id === id) ?? null),
        assignees: row.assigneeIds.map((id) => MEMBERS.find((user) => user.id === id) ?? null),
      });
    }

    throw new Error(`unrouted ${method} ${path}`);
  }) as typeof globalThis.fetch;

  const client = new VikunjaClient(config, { fetch });
  return { client, resolver: new Resolver(client), calls, store };
}

/** The create requests that were issued, in order. */
function creates(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter(
    (call) => call.method === "PUT" && /^\/api\/v1\/projects\/\d+\/tasks$/.test(call.path),
  );
}

/** Whether any write — a create or a label attach — was issued at all. */
function wroteAnything(calls: readonly RecordedCall[]): boolean {
  return calls.some((call) => call.method === "PUT");
}

/** The shipped tool body, with the two projection functions the tool itself passes in. */
function bulkCreate(
  { client, resolver }: Stack,
  target: CreateTasksTarget,
  specs: readonly CreateTaskSpec[],
): Promise<CreatedTasks> {
  return applyBulkCreate(client, resolver, target, specs, toTaskWrite, toLeanTask);
}

describe("bulk create — phase 1 (resolve/validate, all-or-nothing)", () => {
  it("R2: refuses an unknown label, writing nothing and naming it", async () => {
    const harness = stack();

    await assert.rejects(
      bulkCreate(harness, { project: "VMCP" }, [{ title: "x", labels: ["nope"] }]),
      /nope/,
    );
    assert.equal(wroteAnything(harness.calls), false, "nothing was written");
  });

  it("R2: refuses an ambiguous label, writing nothing and naming it", async () => {
    const harness = stack();

    await assert.rejects(
      bulkCreate(harness, { project: "VMCP" }, [{ title: "x", labels: ["dup"] }]),
      /dup/,
    );
    assert.equal(wroteAnything(harness.calls), false, "nothing was written");
  });

  it("R2: refuses an unknown assignee, writing nothing and naming it", async () => {
    const harness = stack();

    await assert.rejects(
      bulkCreate(harness, { project: "VMCP" }, [{ title: "x", assignees: ["ghost"] }]),
      /ghost/,
    );
    assert.equal(wroteAnything(harness.calls), false, "nothing was written");
  });

  it("R2: refuses an unknown project, writing nothing and naming it", async () => {
    const harness = stack();

    await assert.rejects(bulkCreate(harness, { project: "NOPE" }, [{ title: "x" }]), /NOPE/);
    assert.equal(wroteAnything(harness.calls), false, "nothing was written");
  });

  it("R2: resolves every item before the first write — a bad name in item 2 leaves item 1 unwritten", async () => {
    const harness = stack();

    await assert.rejects(
      bulkCreate(harness, { project: "VMCP" }, [
        { title: "First" },
        { title: "x", labels: ["nope"] },
      ]),
      /nope/,
    );
    assert.equal(
      wroteAnything(harness.calls),
      false,
      "not even the resolvable first item was created",
    );
  });

  it("R3: refuses an empty tasks array, issuing no request at all", async () => {
    const harness = stack();

    await assert.rejects(bulkCreate(harness, { project: "VMCP" }, []), /task/i);
    assert.equal(harness.calls.length, 0, "nothing was even resolved");
  });
});

describe("bulk create — phase 2 (execute, best-effort)", () => {
  it("R1: creates one task per spec and returns each as a lean row, in order", async () => {
    const harness = stack();

    const answer = await bulkCreate(harness, { project: "VMCP" }, [
      { title: "First" },
      { title: "Second" },
    ]);

    assert.equal(creates(harness.calls).length, 2, "one PUT per spec");
    assert.deepEqual(
      answer.created.map((row) => row.title),
      ["First", "Second"],
    );
    assert.deepEqual(answer.failed, []);
  });

  it("R4: a rejected create in the middle neither stops the rest nor throws", async () => {
    const harness = stack({ rejectCreateTitles: ["Middle"] });

    const answer = await bulkCreate(harness, { project: "VMCP" }, [
      { title: "First" },
      { title: "Middle" },
      { title: "Third" },
    ]);

    assert.deepEqual(
      answer.created.map((row) => row.title),
      ["First", "Third"],
      "the first and third were still created",
    );
    assert.equal(answer.failed.length, 1);
    assert.equal(answer.failed[0]?.index, 1, "the failure carries the input position");
    assert.match(answer.failed[0]?.error ?? "", /Middle/);
  });

  it("R4: a task that creates but whose label-attach fails is a failure naming the created id", async () => {
    const harness = stack({ rejectLabelIds: [45] });

    const answer = await bulkCreate(harness, { project: "VMCP" }, [
      { title: "Tagged", labels: ["bug"] },
    ]);

    assert.deepEqual(answer.created, [], "the half-finished task is not reported as created");
    assert.equal(answer.failed.length, 1);
    assert.equal(answer.failed[0]?.index, 0);

    // The task WAS created — its id is in the label-attach request path — and the failure must name
    // it, so the caller can find the created-but-unlabelled task rather than re-create it.
    const labelCall = harness.calls.find((call) => /\/tasks\/\d+\/labels$/.test(call.path));
    assert.ok(labelCall);
    const createdId = /\/tasks\/(\d+)\/labels$/.exec(labelCall.path)?.[1];
    assert.ok(createdId);
    assert.match(answer.failed[0]?.error ?? "", new RegExp(createdId));
  });

  it("R5: a created row's labels and assignees reflect the read-back, not the create echo", async () => {
    const harness = stack();

    const answer = await bulkCreate(harness, { project: "VMCP" }, [
      { title: "Tagged", labels: ["bug"], assignees: ["alice"] },
    ]);

    assert.equal(answer.created.length, 1);
    // The create response carried `labels: null` and an assignee with an empty username; only the
    // read-back reports "bug" and "alice", so these assertions fail if the create echo were used.
    assert.deepEqual(answer.created[0]?.labels, ["bug"]);
    assert.deepEqual(answer.created[0]?.assignees, ["alice"]);
    assert.deepEqual(answer.failed, []);
  });
});
