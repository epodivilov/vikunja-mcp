/**
 * End-to-end coverage of the two label data paths, composed from the real `Resolver`,
 * `VikunjaClient` and projection — the exact layers `vikunja_label_task` and
 * `vikunja_set_task_labels` wire together — over a single routing `fetch`. The tool files
 * themselves cannot be imported under `node --test` (they use `.js` value specifiers the
 * type-stripping loader will not resolve to `.ts`), so what is proved here is that the layers fit
 * together: a task ref -> the labels it already carries -> the resulting set -> one bulk write ->
 * the read-back.
 *
 * The stub reproduces the one behaviour of `POST /tasks/{id}/labels/bulk` the design leans on: it
 * reconciles the stored labels to the set it is handed, and answers with the array it was handed
 * rather than with what it stored. A read-back that trusted the response would pass its assertions
 * here by accident, so every answer below is asserted against the stub's own state.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VikunjaClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { toLeanTask } from "../src/projection.ts";
import { type LabelChange, type LabelRef, Resolver } from "../src/resolver.ts";
import type { LeanTask, RawLabel, RawProject, RawTask } from "../src/types.ts";

const config: Config = { baseUrl: "http://vikunja.test/api/v1", token: "t0ken" };

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

/** The instance's labels. "bug" is deliberately duplicated, as it is on the real instance. */
const LABELS: RawLabel[] = [
  { id: 5, title: "feature" },
  { id: 45, title: "specified" },
  { id: 46, title: "in-progress" },
  { id: 2, title: "bug" },
  { id: 3, title: "bug" },
];

const PROJECTS: RawProject[] = [
  { id: 11, title: "Project 11", identifier: "VMCP", description: "", is_archived: false },
];

function labelled(ids: readonly number[]): RawLabel[] {
  return ids.map((id) => {
    const label = LABELS.find((candidate) => candidate.id === id);
    assert.ok(label, `the stub was asked to store an unknown label ${id}`);
    return label;
  });
}

/** One routing fetch over one mutable task, recording every request. */
function stack(current: readonly number[]): {
  client: VikunjaClient;
  resolver: Resolver;
  calls: RecordedCall[];
  stored: () => string[];
} {
  const calls: RecordedCall[] = [];
  const task: RawTask = {
    id: 600,
    project_id: 11,
    index: 3,
    identifier: "VMCP-3",
    title: "Task 600",
    description: "",
    done: false,
    priority: 0,
    due_date: "0001-01-01T00:00:00Z",
    labels: labelled(current),
    assignees: null,
  };

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

    if (method === "GET" && path === "/api/v1/projects") {
      return listing(PROJECTS);
    }

    if (method === "GET" && path === "/api/v1/labels") {
      return listing(LABELS);
    }

    if (method === "GET" && path === "/api/v1/tasks") {
      const parsed = /project_id = (\d+) && index = (\d+)/.exec(
        url.searchParams.get("filter") ?? "",
      );
      const matches =
        parsed !== null &&
        task.project_id === Number(parsed[1]) &&
        task.index === Number(parsed[2]);
      return listing(matches ? [structuredClone(task)] : []);
    }

    if (method === "GET" && path === "/api/v1/tasks/600") {
      return json(structuredClone(task));
    }

    if (method === "POST" && path === "/api/v1/tasks/600/labels/bulk") {
      const payload = body as { labels?: { id: number }[] };
      // What `UpdateTaskLabels` does: reconcile the stored set to the one passed — and then answer
      // with the request's own array, not with what was stored.
      task.labels = labelled((payload.labels ?? []).map((label) => label.id));
      return new Response(JSON.stringify(payload), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`unrouted ${method} ${path}`);
  }) as typeof globalThis.fetch;

  const client = new VikunjaClient(config, { fetch });
  return {
    client,
    resolver: new Resolver(client),
    calls,
    stored: () => (task.labels ?? []).map((label) => label.title),
  };
}

/** The label_task body: resolve the task, compute the resulting set, write it once, read back. */
async function labelTask(
  client: VikunjaClient,
  resolver: Resolver,
  ref: string,
  change: LabelChange,
): Promise<LeanTask> {
  const target = await resolver.resolveTask(ref);
  const next = await resolver.resolveLabelChange(target.labels ?? [], change);
  await client.setTaskLabels(target.id, next);
  return toLeanTask(await client.getTask(target.id));
}

/** The set_task_labels body: resolve the task and every reference, write the set, read back. */
async function setTaskLabels(
  client: VikunjaClient,
  resolver: Resolver,
  ref: string,
  labels: readonly LabelRef[],
): Promise<LeanTask> {
  const target = await resolver.resolveTask(ref);
  const labelIds = await resolver.resolveLabelIds(labels);
  await client.setTaskLabels(target.id, labelIds);
  return toLeanTask(await client.getTask(target.id));
}

describe("label_task data path", () => {
  it("R1/R2/R3: an add and a remove land together in a single bulk write", async () => {
    const { client, resolver, calls, stored } = stack([5, 45]);

    const answer = await labelTask(client, resolver, "VMCP-3", {
      add: ["in-progress"],
      remove: ["specified"],
    });

    const writes = calls.filter((call) => call.method === "POST");
    assert.equal(writes.length, 1, "one write, so no state between the remove and the add");
    assert.equal(writes[0]?.path, "/api/v1/tasks/600/labels/bulk");
    assert.deepEqual(writes[0]?.body, { labels: [{ id: 5 }, { id: 46 }] }, "the resulting set");
    assert.deepEqual(stored(), ["feature", "in-progress"], "feature kept, specified dropped");
    assert.deepEqual(answer.labels, stored(), "R6: the answer reports what the server holds");
    assert.equal(answer.ref, "VMCP-3");
  });

  it("R1/R2: repeating the same call changes nothing and does not error", async () => {
    const { client, resolver, stored } = stack([5, 45]);
    const change: LabelChange = { add: ["in-progress"], remove: ["specified"] };

    await labelTask(client, resolver, "VMCP-3", change);
    // Second time round the add is already on the task and the removal names a label that is not:
    // the set-reconciling endpoint makes both no-ops rather than the 8001 and bare 403 a per-label
    // path would answer with.
    const again = await labelTask(client, resolver, "VMCP-3", change);

    assert.deepEqual(stored(), ["feature", "in-progress"]);
    assert.deepEqual(again.labels, ["feature", "in-progress"]);
  });

  it("R5: an unknown label in add is refused with nothing written", async () => {
    const { client, resolver, calls, stored } = stack([5, 45]);

    await assert.rejects(
      () => labelTask(client, resolver, "VMCP-3", { add: ["nope"] }),
      /No label is titled/,
    );

    assert.ok(!calls.some((call) => call.method === "POST"), "no write was issued");
    assert.deepEqual(stored(), ["feature", "specified"], "the labels are as they were");
  });
});

describe("set_task_labels data path", () => {
  it("R4: the passed list becomes the whole set, detaching what it leaves out", async () => {
    const { client, resolver, calls, stored } = stack([5, 45]);

    const answer = await setTaskLabels(client, resolver, "VMCP-3", ["specified"]);

    const writes = calls.filter((call) => call.method === "POST");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]?.body, { labels: [{ id: 45 }] });
    assert.deepEqual(stored(), ["specified"], "feature detached because the list left it out");
    assert.deepEqual(answer.labels, ["specified"]);
  });

  it("R4: an empty list clears every label, as a request rather than an omission", async () => {
    const { client, resolver, calls, stored } = stack([5, 45]);

    const answer = await setTaskLabels(client, resolver, "VMCP-3", []);

    const writes = calls.filter((call) => call.method === "POST");
    assert.equal(writes.length, 1, "the clear was actually sent");
    assert.deepEqual(writes[0]?.body, { labels: [] });
    assert.deepEqual(stored(), []);
    assert.deepEqual(answer.labels, []);
  });
});
