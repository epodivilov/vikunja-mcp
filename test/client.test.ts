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
