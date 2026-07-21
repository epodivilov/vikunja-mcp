/**
 * The filter expression `listTasks` assembles, pinned through the public API rather than by
 * exporting the builder — the string only matters once it is on the wire, and that is where
 * this reads it back from.
 *
 * The expressions asserted here were checked against a live Vikunja 2.3.0: `project_id = 11`
 * answered 16 rows, `&& done = false` narrowed it to 12, and the unparenthesized
 * `project_id = 11 && done = false || done = true` widened it to 356 rows spanning every
 * project on the instance. That last one is why the escape hatch is parenthesized.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { VikunjaClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";

const config: Config = { baseUrl: "http://vikunja.test/api/v1", token: "t0ken" };

const realFetch = globalThis.fetch;

/** Captures every request URL and answers each one with a single empty page. */
function captureRequests(): string[] {
  const urls: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json", "x-pagination-total-pages": "1" },
    });
  }) as typeof globalThis.fetch;

  return urls;
}

/** The `filter` query parameter of the one request that was made, decoded. */
function filterOf(urls: string[]): string | null {
  assert.equal(urls.length, 1, "expected exactly one request");
  return new URL(urls[0] as string).searchParams.get("filter");
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("listTasks filter assembly", () => {
  it("constrains nothing when the query is empty", async () => {
    const urls = captureRequests();
    await new VikunjaClient(config).listTasks();

    assert.equal(filterOf(urls), null);
  });

  it("builds the project term from projectId", async () => {
    const urls = captureRequests();
    await new VikunjaClient(config).listTasks({ projectId: 11 });

    assert.equal(filterOf(urls), "project_id = 11");
  });

  it("builds the done term from either boolean", async () => {
    const open = captureRequests();
    await new VikunjaClient(config).listTasks({ done: false });
    assert.equal(filterOf(open), "done = false");

    const closed = captureRequests();
    await new VikunjaClient(config).listTasks({ done: true });
    assert.equal(filterOf(closed), "done = true");
  });

  it("ANDs the structured fields in a stable order", async () => {
    const urls = captureRequests();
    await new VikunjaClient(config).listTasks({ done: false, projectId: 11 });

    assert.equal(filterOf(urls), "project_id = 11 && done = false");
  });

  it("passes a lone escape-hatch expression through verbatim", async () => {
    const urls = captureRequests();
    await new VikunjaClient(config).listTasks({ filter: "project_id = 11 && index = 3" });

    assert.equal(filterOf(urls), "project_id = 11 && index = 3");
  });

  it("parenthesizes the escape hatch when it is combined", async () => {
    const urls = captureRequests();
    await new VikunjaClient(config).listTasks({
      projectId: 11,
      filter: "done = false || done = true",
    });

    // Without the parens `&&` would bind tighter than `||` and the project term would apply to
    // the left operand only — the whole instance's done tasks would come back as well.
    assert.equal(filterOf(urls), "project_id = 11 && (done = false || done = true)");
  });

  it("ignores an escape hatch that is only whitespace", async () => {
    const urls = captureRequests();
    await new VikunjaClient(config).listTasks({ projectId: 11, filter: "   " });

    assert.equal(filterOf(urls), "project_id = 11");
  });

  it("refuses a project id that is not a positive integer", async () => {
    captureRequests();
    const client = new VikunjaClient(config);

    assert.throws(() => client.listTasks({ projectId: Number.NaN }), /positive integer/);
    assert.throws(() => client.listTasks({ projectId: 1.5 }), /positive integer/);
    assert.throws(() => client.listTasks({ projectId: 0 }), /positive integer/);
  });

  it("refuses a done filter that is not a boolean", async () => {
    // The same interpolation site as projectId, so the same runtime check. The static type is a
    // compile-time promise; these values arrive as parsed JSON, not as proved booleans.
    captureRequests();
    const client = new VikunjaClient(config);
    const lying = (value: unknown) => client.listTasks({ done: value as boolean });

    assert.throws(() => lying("false"), /true or false/);
    assert.throws(() => lying(0), /true or false/);
    assert.throws(() => lying(null), /true or false/);
  });

  it("keeps search out of the filter expression", async () => {
    const urls = captureRequests();
    await new VikunjaClient(config).listTasks({ projectId: 11, search: "certs" });
    const url = new URL(urls[0] as string);

    assert.equal(url.searchParams.get("filter"), "project_id = 11");
    assert.equal(url.searchParams.get("s"), "certs");
  });
});
