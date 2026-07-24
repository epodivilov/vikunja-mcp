/**
 * Transport-level coverage for `src/client.ts`, driven through the public methods with an
 * injected fake `fetch` as the sole test double — no global monkeypatch. The one seam the
 * client exposes for testing is `ClientOptions.fetch`; everything here rides on it, so the
 * suite has a single convention.
 *
 * Two things are pinned that a fake `fetch` cannot prove, and they are the deliberate
 * exceptions: R1's fallback probe spies on `globalThis.fetch` (and restores it) to show the
 * default path uses the global, and R6 stands up a real `node:http` server because redirect
 * refusal depends on `fetch`'s own `redirect: "manual"` handling.
 *
 * The filter expressions asserted below were checked against a live Vikunja 2.3.0:
 * `project_id = 11` answered 16 rows, `&& done = false` narrowed it to 12, and the
 * unparenthesized `project_id = 11 && done = false || done = true` widened it to 356 rows
 * spanning every project on the instance. That last one is why the escape hatch is parenthesized.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { VikunjaClient, VikunjaHttpError, resolvePageSize } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import type { RawTask } from "../src/types.ts";

const config: Config = { baseUrl: "http://vikunja.test/api/v1", token: "t0ken" };

interface StubCall {
  url: string;
  method: string;
  /** The request body, parsed back from JSON — `undefined` when the request carried none. */
  body: unknown;
}

/**
 * A fake `fetch` that records every call and answers each one from `handler`. Injected via
 * `ClientOptions.fetch`, so the real network — and `globalThis.fetch` — is never touched.
 */
function stubFetch(handler: (call: StubCall) => Response): {
  fetch: typeof globalThis.fetch;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = init?.body;
    const body: unknown = typeof raw === "string" ? JSON.parse(raw) : undefined;
    const call: StubCall = { url: String(input), method: init?.method ?? "GET", body };
    calls.push(call);
    return handler(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** A 200 page of `items`. Omitting `totalPages` leaves out the pagination header entirely. */
function page(items: unknown[], totalPages?: number): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (totalPages !== undefined) {
    headers["x-pagination-total-pages"] = String(totalPages);
  }
  return new Response(JSON.stringify(items), { status: 200, headers });
}

/** A 200 response carrying a bare JSON object — the shape `GET /info` answers with. */
function jsonObject(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** The `filter` query parameter of the one request that was made, decoded. */
function filterOf(calls: StubCall[]): string | null {
  assert.equal(calls.length, 1, "expected exactly one request");
  const [first] = calls;
  assert.ok(first);
  return new URL(first.url).searchParams.get("filter");
}

describe("client transport: dependency-injection seam", () => {
  it("R1: routes every request through options.fetch, never the global", async () => {
    const saved = globalThis.fetch;
    let globalCalls = 0;
    globalThis.fetch = (async () => {
      globalCalls++;
      throw new Error("globalThis.fetch was used despite an injected fetch");
    }) as typeof globalThis.fetch;

    try {
      const { fetch, calls } = stubFetch(() => page([], 1));
      await new VikunjaClient(config, { fetch }).listProjects();

      assert.equal(calls.length, 1, "the injected fetch received the call");
      assert.equal(globalCalls, 0, "the global was never touched");
    } finally {
      globalThis.fetch = saved;
    }
  });

  it("R1: falls back to globalThis.fetch when options.fetch is absent", async () => {
    const saved = globalThis.fetch;
    let globalCalls = 0;
    globalThis.fetch = (async () => {
      globalCalls++;
      return page([], 1);
    }) as typeof globalThis.fetch;

    try {
      await new VikunjaClient(config).listProjects();
      assert.equal(globalCalls, 1, "the default path used the global fetch");
    } finally {
      globalThis.fetch = saved;
    }
  });
});

describe("listTasks filter assembly", () => {
  it("constrains nothing when the query is empty", async () => {
    const { fetch, calls } = stubFetch(() => page([], 1));
    await new VikunjaClient(config, { fetch }).listTasks();

    assert.equal(filterOf(calls), null);
  });

  it("builds the project term from projectId", async () => {
    const { fetch, calls } = stubFetch(() => page([], 1));
    await new VikunjaClient(config, { fetch }).listTasks({ projectId: 11 });

    assert.equal(filterOf(calls), "project_id = 11");
  });

  it("builds the done term from either boolean", async () => {
    const open = stubFetch(() => page([], 1));
    await new VikunjaClient(config, { fetch: open.fetch }).listTasks({ done: false });
    assert.equal(filterOf(open.calls), "done = false");

    const closed = stubFetch(() => page([], 1));
    await new VikunjaClient(config, { fetch: closed.fetch }).listTasks({ done: true });
    assert.equal(filterOf(closed.calls), "done = true");
  });

  it("ANDs the structured fields in a stable order", async () => {
    const { fetch, calls } = stubFetch(() => page([], 1));
    await new VikunjaClient(config, { fetch }).listTasks({ done: false, projectId: 11 });

    assert.equal(filterOf(calls), "project_id = 11 && done = false");
  });

  it("passes a lone escape-hatch expression through verbatim", async () => {
    const { fetch, calls } = stubFetch(() => page([], 1));
    await new VikunjaClient(config, { fetch }).listTasks({
      filter: "project_id = 11 && index = 3",
    });

    assert.equal(filterOf(calls), "project_id = 11 && index = 3");
  });

  it("parenthesizes the escape hatch when it is combined", async () => {
    const { fetch, calls } = stubFetch(() => page([], 1));
    await new VikunjaClient(config, { fetch }).listTasks({
      projectId: 11,
      filter: "done = false || done = true",
    });

    // Without the parens `&&` would bind tighter than `||` and the project term would apply to
    // the left operand only — the whole instance's done tasks would come back as well.
    assert.equal(filterOf(calls), "project_id = 11 && (done = false || done = true)");
  });

  it("ignores an escape hatch that is only whitespace", async () => {
    const { fetch, calls } = stubFetch(() => page([], 1));
    await new VikunjaClient(config, { fetch }).listTasks({ projectId: 11, filter: "   " });

    assert.equal(filterOf(calls), "project_id = 11");
  });

  it("refuses a project id that is not a positive integer", () => {
    const { fetch } = stubFetch(() => page([], 1));
    const client = new VikunjaClient(config, { fetch });

    assert.throws(() => client.listTasks({ projectId: Number.NaN }), /positive integer/);
    assert.throws(() => client.listTasks({ projectId: 1.5 }), /positive integer/);
    assert.throws(() => client.listTasks({ projectId: 0 }), /positive integer/);
  });

  it("refuses a done filter that is not a boolean", () => {
    // The same interpolation site as projectId, so the same runtime check. The static type is a
    // compile-time promise; these values arrive as parsed JSON, not as proved booleans.
    const { fetch } = stubFetch(() => page([], 1));
    const client = new VikunjaClient(config, { fetch });
    const lying = (value: unknown) => client.listTasks({ done: value as boolean });

    assert.throws(() => lying("false"), /true or false/);
    assert.throws(() => lying(0), /true or false/);
    assert.throws(() => lying(null), /true or false/);
  });

  it("keeps search out of the filter expression", async () => {
    const { fetch, calls } = stubFetch(() => page([], 1));
    await new VikunjaClient(config, { fetch }).listTasks({ projectId: 11, search: "certs" });
    const [first] = calls;
    assert.ok(first);
    const url = new URL(first.url);

    assert.equal(url.searchParams.get("filter"), "project_id = 11");
    assert.equal(url.searchParams.get("s"), "certs");
  });
});

describe("client transport: pagination", () => {
  it("R2: requests every page and concatenates items in page order", async () => {
    const { fetch, calls } = stubFetch((call) => {
      const pageNumber = Number(new URL(call.url).searchParams.get("page"));
      return page([{ id: pageNumber }], 3);
    });

    const result = await new VikunjaClient(config, { fetch }).listProjects();

    const requested = calls.map((call) => new URL(call.url).searchParams.get("page"));
    assert.deepEqual(requested, ["1", "2", "3"]);
    assert.deepEqual(result, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("R3: an empty collection makes exactly one request and returns []", async () => {
    const { fetch, calls } = stubFetch(() => page([], 0));

    const result = await new VikunjaClient(config, { fetch }).listProjects();

    assert.equal(calls.length, 1);
    assert.deepEqual(result, []);
  });

  it("R3: a missing page-count header makes one request and returns that page", async () => {
    const { fetch, calls } = stubFetch(() => page([{ id: 1 }]));

    const result = await new VikunjaClient(config, { fetch }).listProjects();

    assert.equal(calls.length, 1);
    assert.deepEqual(result, [{ id: 1 }]);
  });

  it("R4: a page count past the cap throws and makes only one request", async () => {
    const { fetch, calls } = stubFetch(() => page([], 501));

    await assert.rejects(new VikunjaClient(config, { fetch }).listProjects(), /past the 500/);
    assert.equal(calls.length, 1);
  });
});

describe("client transport: error mapping", () => {
  it("R5: a JSON error body carries status, Vikunja code, message and code text", async () => {
    const { fetch } = stubFetch(
      () =>
        new Response(JSON.stringify({ code: 3005, message: "task does not exist" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );

    await assert.rejects(new VikunjaClient(config, { fetch }).listProjects(), (error: unknown) => {
      assert.ok(error instanceof VikunjaHttpError);
      assert.equal(error.status, 404);
      assert.equal(error.code, 3005);
      assert.match(error.message, /task does not exist/);
      assert.match(error.message, /3005/);
      return true;
    });
  });

  it("R5: a non-JSON error body carries status, undefined code and the raw body", async () => {
    const { fetch } = stubFetch(
      () =>
        new Response("upstream boom", { status: 500, headers: { "content-type": "text/plain" } }),
    );

    await assert.rejects(new VikunjaClient(config, { fetch }).listProjects(), (error: unknown) => {
      assert.ok(error instanceof VikunjaHttpError);
      assert.equal(error.status, 500);
      assert.equal(error.code, undefined);
      assert.match(error.message, /upstream boom/);
      return true;
    });
  });

  it("R5: an empty error body renders <empty body>", async () => {
    const { fetch } = stubFetch(() => new Response("", { status: 502 }));

    await assert.rejects(new VikunjaClient(config, { fetch }).listProjects(), (error: unknown) => {
      assert.ok(error instanceof VikunjaHttpError);
      assert.equal(error.status, 502);
      assert.match(error.message, /<empty body>/);
      return true;
    });
  });
});

describe("client transport: redirect refusal", () => {
  it("R6: refuses a 3xx instead of following it", async () => {
    // A real server, because redirect refusal is `fetch`'s own `redirect: "manual"` at work,
    // which a fake fetch cannot exercise. The redirect target answers `200 []`, so "refused"
    // (rejects 302) is distinguishable from "followed" (resolves []) — the distinction that
    // fails this test the moment `redirect: "manual"` is dropped.
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/api/v1/projects")) {
        res.writeHead(302, { Location: "/api/v1/followed", Connection: "close" });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "x-pagination-total-pages": "1",
        Connection: "close",
      });
      res.end("[]");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      assert.ok(address !== null && typeof address === "object", "server bound to a TCP port");
      const redirectConfig: Config = {
        baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
        token: "t0ken",
      };

      await assert.rejects(new VikunjaClient(redirectConfig).listProjects(), (error: unknown) => {
        assert.ok(error instanceof VikunjaHttpError);
        assert.equal(error.status, 302);
        assert.match(error.message, /Not followed/);
        return true;
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("client transport: kanban board", () => {
  function boardTask(id: number, index: number, identifier: string): RawTask {
    return {
      id,
      project_id: 3,
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

  it("reads the board from the view-tasks endpoint and nowhere else", async () => {
    const { fetch, calls } = stubFetch(() => page([{ id: 7, title: "To-Do", tasks: [] }], 1));

    await new VikunjaClient(config, { fetch }).readBoard(3, 12);

    for (const call of calls) {
      assert.equal(
        new URL(call.url).pathname,
        "/api/v1/projects/3/views/12/tasks",
        "only the per-view kanban endpoint is read — never /buckets, never the flat /tasks list",
      );
    }
  });

  it("merges every page of a column, since the board read always reports a single page", async () => {
    // The kanban view-tasks response slices tasks WITHIN each bucket by `page`, while
    // x-pagination-total-pages is always 1 (it counts buckets, not tasks). A loop that trusted
    // that header would truncate a column at one page; readBoard walks until a page adds no task
    // to any bucket. The stub reproduces that shape: same page number sliced into every bucket.
    const board = [
      {
        id: 7,
        title: "To-Do",
        tasks: [boardTask(1, 1, "INFRA-1"), boardTask(2, 2, "INFRA-2"), boardTask(3, 3, "INFRA-3")],
      },
      { id: 9, title: "Done", tasks: [boardTask(9, 9, "INFRA-9")] },
    ];

    const { fetch, calls } = stubFetch((call) => {
      const params = new URL(call.url).searchParams;
      const pageNumber = Number(params.get("page"));
      const perPage = Number(params.get("per_page"));
      const start = (pageNumber - 1) * perPage;
      const sliced = board.map((bucket) => ({
        id: bucket.id,
        title: bucket.title,
        tasks: bucket.tasks.slice(start, start + perPage),
      }));
      return page(sliced, 1);
    });

    const result = await new VikunjaClient(config, { fetch, pageSize: 2 }).readBoard(3, 12);

    assert.deepEqual(
      result.map((bucket) => bucket.id),
      [7, 9],
      "columns kept in first-seen order",
    );
    assert.deepEqual(
      result[0]?.tasks?.map((task) => task.id),
      [1, 2, 3],
      "To-Do merged across pages rather than truncated at the first",
    );
    assert.deepEqual(
      result[1]?.tasks?.map((task) => task.id),
      [9],
      "Done kept its single task",
    );
    assert.ok(calls.length >= 2, "walked past the first page");
  });

  it("lists a project's views from the views endpoint", async () => {
    const { fetch, calls } = stubFetch(() =>
      page([{ id: 12, position: 3, view_kind: "kanban", bucket_configuration_mode: "manual" }], 1),
    );

    const views = await new VikunjaClient(config, { fetch }).listViews(3);

    const [call] = calls;
    assert.ok(call);
    assert.equal(new URL(call.url).pathname, "/api/v1/projects/3/views");
    assert.equal(views[0]?.id, 12);
  });

  it("lists a view's buckets from the buckets endpoint", async () => {
    const { fetch, calls } = stubFetch(() => page([{ id: 7, title: "To-Do", tasks: null }], 1));

    await new VikunjaClient(config, { fetch }).listBuckets(3, 12);

    const [call] = calls;
    assert.ok(call);
    assert.equal(new URL(call.url).pathname, "/api/v1/projects/3/views/12/buckets");
  });

  it("moves a task by POSTing task_id to the bucket-tasks endpoint", async () => {
    const { fetch, calls } = stubFetch(
      () =>
        new Response(JSON.stringify({ task_id: 530, bucket_id: 8 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await new VikunjaClient(config, { fetch }).moveTask(3, 12, 8, 530);

    const [call] = calls;
    assert.ok(call);
    assert.equal(call.method, "POST");
    assert.equal(new URL(call.url).pathname, "/api/v1/projects/3/views/12/buckets/8/tasks");
    assert.deepEqual(call.body, { task_id: 530 });
  });
});

describe("client transport: task labels", () => {
  /** What `POST /tasks/{id}/labels/bulk` answers: 201 echoing the labels it was handed. */
  function bulkEcho(call: StubCall): Response {
    return new Response(JSON.stringify(call.body), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }

  it("R4: writes the whole label set with one POST to the bulk endpoint", async () => {
    const { fetch, calls } = stubFetch(bulkEcho);

    await new VikunjaClient(config, { fetch }).setTaskLabels(7, [45, 5]);

    assert.equal(calls.length, 1, "one request for the set — never one per label");
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.method, "POST");
    assert.equal(new URL(call.url).pathname, "/api/v1/tasks/7/labels/bulk");
    // Only `id` is read server-side, and the order is the caller's.
    assert.deepEqual(call.body, { labels: [{ id: 45 }, { id: 5 }] });
  });

  it("R2/R4: sends an empty array rather than skipping the call, which is how labels are cleared", async () => {
    const { fetch, calls } = stubFetch(bulkEcho);

    await new VikunjaClient(config, { fetch }).setTaskLabels(7, []);

    assert.equal(calls.length, 1, "the clear is a request, not an omission");
    const [call] = calls;
    assert.ok(call);
    assert.equal(new URL(call.url).pathname, "/api/v1/tasks/7/labels/bulk");
    assert.deepEqual(call.body, { labels: [] });
  });

  it("R4: surfaces a rejected write as a VikunjaHttpError carrying status and code", async () => {
    // The handler runs the whole reconciliation in one transaction, so a rejected label id rolls
    // back the deletes too — the caller has to learn that nothing landed rather than assume it did.
    const { fetch } = stubFetch(
      () =>
        new Response(JSON.stringify({ code: 8002, message: "label does not exist" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );

    await assert.rejects(
      new VikunjaClient(config, { fetch }).setTaskLabels(7, [999]),
      (error: unknown) => {
        assert.ok(error instanceof VikunjaHttpError);
        assert.equal(error.status, 400);
        assert.equal(error.code, 8002);
        assert.match(error.message, /label does not exist/);
        return true;
      },
    );
  });
});

describe("client transport: assignees", () => {
  it("R1: addTaskAssignee PUTs { user_id } to the task's assignees endpoint", async () => {
    const { fetch, calls } = stubFetch(() => new Response("", { status: 201 }));

    await new VikunjaClient(config, { fetch }).addTaskAssignee(7, 3);

    assert.equal(calls.length, 1, "one assignment is one request");
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.method, "PUT");
    assert.equal(new URL(call.url).pathname, "/api/v1/tasks/7/assignees");
    assert.deepEqual(call.body, { user_id: 3 });
  });

  it("R2: removeTaskAssignee DELETEs the user's own path, with no body", async () => {
    const { fetch, calls } = stubFetch(() => new Response("", { status: 200 }));

    await new VikunjaClient(config, { fetch }).removeTaskAssignee(7, 3);

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.method, "DELETE");
    assert.equal(new URL(call.url).pathname, "/api/v1/tasks/7/assignees/3");
    assert.equal(call.body, undefined, "the user is named by the path, so nothing is sent");
  });

  it("R1: addTaskAssignees writes each user in turn, one request apiece", async () => {
    const { fetch, calls } = stubFetch(() => new Response("", { status: 201 }));

    await new VikunjaClient(config, { fetch }).addTaskAssignees(7, [3, 5]);

    assert.deepEqual(
      calls.map((call) => call.body),
      [{ user_id: 3 }, { user_id: 5 }],
    );
  });

  it("R1: a refusal after an earlier write landed names what is already assigned", async () => {
    // The refusal cannot be pre-empted: a user id is deliberately not gated on the member
    // listing, so the first anyone hears of it is the 403. What must not happen is reporting
    // that as a plain failure — the earlier assignment is on the task and stays there.
    const { fetch, calls } = stubFetch((call) => {
      const { user_id: userId } = call.body as { user_id: number };
      return userId === 9
        ? new Response(JSON.stringify({ code: 7003, message: "You don't have the right" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          })
        : new Response("", { status: 201 });
    });

    await assert.rejects(
      () => new VikunjaClient(config, { fetch }).addTaskAssignees(7, [5, 9]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /user 5/, "names the assignment that landed");
        assert.match(error.message, /7003/, "keeps the server's own refusal verbatim");
        assert.ok(error.cause instanceof VikunjaHttpError, "the server's error stays reachable");
        return true;
      },
    );

    assert.equal(calls.length, 2, "stopped at the refusal rather than writing on");
  });

  it("R1: a refusal on the very first write is passed through untouched", async () => {
    // Nothing landed, so there is nothing to add to the server's own message — and a
    // half-application note on a call that applied nothing would be its own kind of lie.
    const { fetch } = stubFetch(
      () =>
        new Response(JSON.stringify({ code: 7003, message: "You don't have the right" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );

    await assert.rejects(
      () => new VikunjaClient(config, { fetch }).addTaskAssignees(7, [9]),
      (error: unknown) => {
        assert.ok(error instanceof VikunjaHttpError, "not reclassified into something else");
        assert.equal(error.status, 403);
        assert.doesNotMatch(error.message, /already assigned/, "no partial-application note");
        return true;
      },
    );
  });

  it("R5: reads an unpaginated projectusers response in a single request", async () => {
    // The real handler answers `c.JSON(200, users)` — a bare array with no x-pagination-*
    // headers at all, which `page()` reproduces by omitting the page count.
    const { fetch, calls } = stubFetch(() =>
      page([
        { id: 3, username: "alice", name: "Alice A" },
        { id: 5, username: "bob", name: "" },
      ]),
    );

    const users = await new VikunjaClient(config, { fetch }).listProjectUsers(11);

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call);
    assert.equal(new URL(call.url).pathname, "/api/v1/projects/11/projectusers");
    assert.deepEqual(
      users.map((user) => user.username),
      ["alice", "bob"],
    );
  });

  it("R5: still exhausts pagination if an instance ever reports more than one page", async () => {
    const { fetch, calls } = stubFetch((call) => {
      const pageNumber = Number(new URL(call.url).searchParams.get("page"));
      return page([{ id: pageNumber, username: `user${pageNumber}`, name: "" }], 2);
    });

    const users = await new VikunjaClient(config, { fetch }).listProjectUsers(11);

    assert.deepEqual(
      calls.map((call) => new URL(call.url).searchParams.get("page")),
      ["1", "2"],
    );
    assert.deepEqual(
      users.map((user) => user.username),
      ["user1", "user2"],
      "a paginating server is walked, not truncated at page 1",
    );
  });

  it("R7: createTask carries assignees as id objects alongside the other fields", async () => {
    const { fetch, calls } = stubFetch(() => jsonObject({ id: 601 }));

    await new VikunjaClient(config, { fetch }).createTask(
      11,
      { title: "Ship it", description: "<p>body</p>" },
      [3, 5],
    );

    const [call] = calls;
    assert.ok(call);
    assert.equal(call.method, "PUT");
    assert.equal(new URL(call.url).pathname, "/api/v1/projects/11/tasks");
    assert.deepEqual(call.body, {
      title: "Ship it",
      description: "<p>body</p>",
      assignees: [{ id: 3 }, { id: 5 }],
    });
  });

  it("R7: createTask sends no assignees key when the call names none", async () => {
    const { fetch, calls } = stubFetch(() => jsonObject({ id: 601 }));

    await new VikunjaClient(config, { fetch }).createTask(11, { title: "Ship it" });

    const [call] = calls;
    assert.ok(call);
    assert.deepEqual(call.body, { title: "Ship it" });
  });
});

describe("client transport: read-modify-write", () => {
  it("R7: updateTask preserves the fields the patch omits", async () => {
    const current: RawTask = {
      id: 579,
      title: "Original title",
      description: "<p>original description</p>",
      done: false,
      project_id: 14,
      priority: 4,
      due_date: "2026-01-01T00:00:00Z",
      index: 1,
      identifier: "VMCP-1",
      labels: null,
      assignees: [{ id: 3, username: "alice", name: "Alice A" }],
    };

    const { fetch, calls } = stubFetch((call) => {
      if (call.method === "POST") {
        // Must echo a non-empty object, or `#requestObject` throws "empty body where an object
        // was due" before the assertion below can run.
        return new Response(JSON.stringify({ ...current, ...(call.body as object) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(current), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await new VikunjaClient(config, { fetch }).updateTask(579, { done: true });

    const post = calls.find((call) => call.method === "POST");
    assert.ok(post, "updateTask issued a POST");
    const body = post.body as Record<string, unknown>;
    assert.equal(body.done, true, "the patch was applied");
    assert.equal(body.description, current.description, "description preserved");
    assert.equal(body.priority, current.priority, "priority preserved");
    assert.equal(body.due_date, current.due_date, "due_date preserved");
    assert.equal(body.title, current.title, "title preserved");
    // `POST /tasks/{id}` replaces assignees wholesale from its payload, so echoing the server's
    // own list back is the only reason an update does not silently unassign everyone.
    assert.deepEqual(body.assignees, current.assignees, "assignees preserved");
  });
});

describe("client transport: page-size discovery", () => {
  /** The decoded `per_page` of the first request that hit the list endpoint. */
  function perPageOf(calls: StubCall[]): string | null {
    const listCall = calls.find((call) => call.url.includes("/projects"));
    assert.ok(listCall, "a list request was made");
    return new URL(listCall.url).searchParams.get("per_page");
  }

  it("R1: reads max_items_per_page from /info and sends it as per_page", async () => {
    const { fetch, calls } = stubFetch((call) =>
      call.url.includes("/info") ? jsonObject({ max_items_per_page: 50 }) : page([], 1),
    );

    const pageSize = await resolvePageSize(config, { fetch });
    await new VikunjaClient(config, { fetch, pageSize }).listProjects();

    const infoCalls = calls.filter((call) => call.url.includes("/info"));
    assert.equal(infoCalls.length, 1, "/info was requested exactly once");
    assert.equal(perPageOf(calls), "50");
  });

  const fallbackCases: Array<{ name: string; info: () => Response }> = [
    {
      name: "a rejected connection",
      info: () => {
        throw new Error("ECONNREFUSED");
      },
    },
    { name: "a non-2xx answer", info: () => new Response("boom", { status: 500 }) },
    {
      name: "a non-JSON body",
      info: () =>
        new Response("<html>not json</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    },
    { name: "an absent field", info: () => jsonObject({ version: "0.24.0" }) },
    { name: "a zero field", info: () => jsonObject({ max_items_per_page: 0 }) },
    { name: "a negative field", info: () => jsonObject({ max_items_per_page: -50 }) },
    { name: "a non-integer field", info: () => jsonObject({ max_items_per_page: 12.5 }) },
    { name: "a non-number field", info: () => jsonObject({ max_items_per_page: "50" }) },
  ];

  for (const { name, info } of fallbackCases) {
    it(`R2: falls back to the default page size on ${name}`, async () => {
      const { fetch, calls } = stubFetch((call) =>
        call.url.includes("/info") ? info() : page([], 1),
      );

      const pageSize = await resolvePageSize(config, { fetch });
      assert.equal(pageSize, 1000, "discovery fell back to the default");

      await new VikunjaClient(config, { fetch, pageSize }).listProjects();
      assert.equal(perPageOf(calls), "1000");
    });
  }

  it("R3: an explicit page size is used verbatim and /info is never requested", async () => {
    const { fetch, calls } = stubFetch((call) =>
      call.url.includes("/info") ? jsonObject({ max_items_per_page: 50 }) : page([], 1),
    );

    await new VikunjaClient(config, { fetch, pageSize: 5 }).listProjects();

    const infoCalls = calls.filter((call) => call.url.includes("/info"));
    assert.equal(infoCalls.length, 0, "/info was not requested");
    assert.equal(perPageOf(calls), "5");
  });

  it("R4: emits exactly one fallback diagnostic naming the default page size", async () => {
    const { fetch } = stubFetch((call) =>
      call.url.includes("/info") ? new Response("", { status: 500 }) : page([], 1),
    );

    const lines: string[] = [];
    const pageSize = await resolvePageSize(config, {
      fetch,
      warn: (message) => lines.push(message),
    });

    assert.equal(pageSize, 1000);
    assert.equal(lines.length, 1, "exactly one diagnostic line");
    const [line] = lines;
    assert.ok(line);
    assert.match(line, /1000/);
  });
});
