/**
 * End-to-end coverage of the two kanban data paths, composed from the real `Resolver`,
 * `VikunjaClient` and projection — the exact layers `vikunja_get_board` and `vikunja_move_task`
 * wire together — over a single routing `fetch`. The tool files themselves are thin adapters,
 * exercised directly for their registration and guards in `test/tools.test.ts`; what is proved
 * here is that the layers fit together: a project key -> its kanban view -> the board read ->
 * lean board, and a task ref -> its project's view -> the target column -> the move POST -> the
 * read-back.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VikunjaClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { toLeanBoard, toLeanTask } from "../src/projection.ts";
import { Resolver } from "../src/resolver.ts";
import type { LeanBoard, LeanTask, RawBucket, RawProject, RawTask, RawView } from "../src/types.ts";

const config: Config = { baseUrl: "http://vikunja.test/api/v1", token: "t0ken" };

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

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

function rawProject(id: number, identifier: string): RawProject {
  return { id, title: `Project ${id}`, identifier, description: "", is_archived: false };
}

function rawView(id: number, kind: string, mode: string): RawView {
  return { id, position: 1, view_kind: kind, bucket_configuration_mode: mode };
}

const INFRA_TASK = rawTask(530, 3, 3, "INFRA-3");
const VMCP_TASK = rawTask(600, 11, 3, "VMCP-3");
const ALL_TASKS: RawTask[] = [INFRA_TASK, VMCP_TASK];

const PROJECTS: RawProject[] = [rawProject(3, "INFRA"), rawProject(11, "VMCP")];

const VIEWS: Record<string, RawView[]> = {
  "3": [rawView(12, "kanban", "manual")],
  "11": [rawView(44, "kanban", "filter")],
};

const BUCKETS: Record<string, RawBucket[]> = {
  "3/12": [
    { id: 7, title: "To-Do", tasks: null },
    { id: 8, title: "Doing", tasks: null },
    { id: 9, title: "Done", tasks: null },
  ],
};

/** The view-tasks read: buckets with their tasks embedded, in column order. */
const BOARD: Record<string, RawBucket[]> = {
  "3/12": [
    { id: 7, title: "To-Do", tasks: [INFRA_TASK] },
    { id: 8, title: "Doing", tasks: [] },
    { id: 9, title: "Done", tasks: [] },
  ],
  "11/44": [
    { id: 0, title: "Specified", tasks: [VMCP_TASK] },
    { id: 1, title: "In Progress", tasks: [] },
  ],
};

/** One routing fetch answering every endpoint the two flows touch, recording each request. */
function stack(): { client: VikunjaClient; resolver: Resolver; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

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

    if (method === "GET" && path === "/api/v1/tasks") {
      const parsed = /project_id = (\d+) && index = (\d+)/.exec(
        url.searchParams.get("filter") ?? "",
      );
      const rows = parsed
        ? ALL_TASKS.filter(
            (task) => task.project_id === Number(parsed[1]) && task.index === Number(parsed[2]),
          )
        : [];
      return listing(rows);
    }

    const taskById = /^\/api\/v1\/tasks\/(\d+)$/.exec(path);
    if (method === "GET" && taskById) {
      const wanted = Number(taskById[1]);
      return json(ALL_TASKS.find((task) => task.id === wanted) ?? null);
    }

    const viewsOf = /^\/api\/v1\/projects\/(\d+)\/views$/.exec(path);
    if (method === "GET" && viewsOf) {
      return listing(VIEWS[viewsOf[1] ?? ""] ?? []);
    }

    const bucketsOf = /^\/api\/v1\/projects\/(\d+)\/views\/(\d+)\/buckets$/.exec(path);
    if (method === "GET" && bucketsOf) {
      return listing(BUCKETS[`${bucketsOf[1]}/${bucketsOf[2]}`] ?? []);
    }

    const boardOf = /^\/api\/v1\/projects\/(\d+)\/views\/(\d+)\/tasks$/.exec(path);
    if (method === "GET" && boardOf) {
      const perPage = Number(url.searchParams.get("per_page"));
      const start = (Number(url.searchParams.get("page")) - 1) * perPage;
      const board = BOARD[`${boardOf[1]}/${boardOf[2]}`] ?? [];
      const sliced = board.map((bucket) => ({
        id: bucket.id,
        title: bucket.title,
        tasks: (bucket.tasks ?? []).slice(start, start + perPage),
      }));
      return listing(sliced);
    }

    const moveOf = /^\/api\/v1\/projects\/(\d+)\/views\/(\d+)\/buckets\/(\d+)\/tasks$/.exec(path);
    if (method === "POST" && moveOf) {
      const moved = body as { task_id?: number };
      return json({ task_id: moved.task_id, bucket_id: Number(moveOf[3]) });
    }

    throw new Error(`unrouted ${method} ${path}`);
  }) as typeof globalThis.fetch;

  const client = new VikunjaClient(config, { fetch });
  return { client, resolver: new Resolver(client), calls };
}

/** The get_board body: resolve the project's kanban view, read its board, project to lean. */
async function readBoard(
  client: VikunjaClient,
  resolver: Resolver,
  projectId: number,
): Promise<LeanBoard> {
  const view = await resolver.resolveKanbanView(projectId);
  return toLeanBoard(view.mode, await client.readBoard(projectId, view.id));
}

/** The move_task body for a manual board: resolve the view and column, move, read back. */
async function moveTask(
  client: VikunjaClient,
  resolver: Resolver,
  ref: string,
  column: string,
): Promise<LeanTask> {
  const target = await resolver.resolveTask(ref);
  const view = await resolver.resolveKanbanView(target.project_id);
  const bucketId = await resolver.resolveBucketId(target.project_id, view.id, column);
  await client.moveTask(target.project_id, view.id, bucketId, target.id);
  return toLeanTask(await client.getTask(target.id));
}

describe("get_board data path", () => {
  it("R1: a project's kanban view -> its board read -> an ordered lean board (manual)", async () => {
    const { client, resolver } = stack();

    // The project key was already resolved to id 3 in the real tool; the view path starts here.
    const board = await readBoard(client, resolver, 3);

    assert.equal(board.mode, "manual");
    assert.deepEqual(
      board.columns.map((column) => column.name),
      ["To-Do", "Doing", "Done"],
    );
    assert.deepEqual(board.columns[0]?.tasks, [
      { ref: "INFRA-3", id: 530, title: "Task 530", done: false, labels: [] },
    ]);
  });

  it("R1: a filter board comes back with the same lean shape and mode filter", async () => {
    const { client, resolver } = stack();

    const board = await readBoard(client, resolver, 11);

    assert.equal(board.mode, "filter");
    assert.deepEqual(
      board.columns.map((column) => column.name),
      ["Specified", "In Progress"],
    );
  });

  it("R1: the board is read from the view-tasks endpoint, never /buckets or the flat /tasks", async () => {
    const { client, resolver, calls } = stack();

    await readBoard(client, resolver, 3);

    assert.ok(
      calls.some((call) => call.path === "/api/v1/projects/3/views/12/tasks"),
      "read the per-view kanban endpoint",
    );
    assert.ok(!calls.some((call) => /\/buckets(\/|$)/.test(call.path)), "never read /buckets");
    assert.ok(
      !calls.some((call) => call.path === "/api/v1/tasks"),
      "never used the flat task list",
    );
  });
});

describe("move_task data path", () => {
  it("R5: a ref -> its manual view -> the column bucket -> a POST of { task_id }", async () => {
    const { client, resolver, calls } = stack();

    const moved = await moveTask(client, resolver, "INFRA-3", "Doing");

    const post = calls.find((call) => call.method === "POST");
    assert.ok(post, "issued the move POST");
    assert.equal(post.path, "/api/v1/projects/3/views/12/buckets/8/tasks");
    assert.deepEqual(post.body, { task_id: 530 });
    assert.equal(moved.ref, "INFRA-3", "answered with the moved task, read back from the server");
  });

  it("R6: a task on a filter board resolves to filter mode, which is what makes move_task refuse", async () => {
    const { client, resolver, calls } = stack();

    // move_task branches on this before issuing any request; a filter board has no task_buckets
    // rows to write, so the mode alone determines the refusal.
    const target = await resolver.resolveTask("VMCP-3");
    const view = await resolver.resolveKanbanView(target.project_id);

    assert.equal(view.mode, "filter");
    assert.ok(!calls.some((call) => call.method === "POST"), "nothing was moved");
  });
});
