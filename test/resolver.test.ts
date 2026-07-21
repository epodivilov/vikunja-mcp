/**
 * The stub below answers `project_id = N && index = M` because that is what the live server
 * does — checked against Vikunja 2.3.0, where the filter returns exactly the one task. The
 * `honoursIndex: false` mode is the same server with that term ignored, which is how an older
 * or newer build would behave and the one case where a wrong answer is worse than an error.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Resolver, type ResolverClient, formatRef, parseTaskRef } from "../src/resolver.ts";
import type { RawProject, RawTask } from "../src/types.ts";

function project(id: number, identifier: string): RawProject {
  return { id, title: `Project ${id}`, identifier, description: "", is_archived: false };
}

function task(id: number, projectId: number, index: number): RawTask {
  return {
    id,
    project_id: projectId,
    index,
    identifier: "",
    title: `Task ${id}`,
    description: "",
    done: false,
    priority: 0,
    due_date: "0001-01-01T00:00:00Z",
    labels: null,
  };
}

interface StubOptions {
  /** False emulates a server that drops the `index` term and answers with the whole project. */
  honoursIndex?: boolean;
  /** Number of leading `listProjects` calls that fail, to exercise cache recovery. */
  failures?: number;
}

interface Stub extends ResolverClient {
  calls: { listProjects: number; filters: string[] };
}

function stubClient(projects: RawProject[], tasks: RawTask[], options: StubOptions = {}): Stub {
  const calls = { listProjects: 0, filters: [] as string[] };
  let failures = options.failures ?? 0;

  return {
    calls,
    listProjects: async () => {
      calls.listProjects++;
      if (failures > 0) {
        failures--;
        throw new Error("boom");
      }
      return projects;
    },
    listTasks: async (query) => {
      const filter = query.filter ?? "";
      calls.filters.push(filter);

      const parsed = /^project_id = (\d+) && index = (\d+)$/.exec(filter);
      assert.ok(parsed, `resolver wrote an unexpected filter: ${filter}`);

      const projectId = Number(parsed[1]);
      const index = Number(parsed[2]);

      return tasks.filter(
        (row) =>
          row.project_id === projectId && (options.honoursIndex === false || row.index === index),
      );
    },
  };
}

const PROJECTS = [project(7, "INFRA"), project(11, "VMCP")];
const TASKS = [task(301, 7, 41), task(302, 7, 42), task(530, 11, 1)];

describe("parseTaskRef", () => {
  it("splits a key into prefix and index", () => {
    assert.deepEqual(parseTaskRef("INFRA-41"), { prefix: "INFRA", index: 41 });
  });

  it("upper-cases the prefix and trims the input", () => {
    assert.deepEqual(parseTaskRef("  infra-41 "), { prefix: "INFRA", index: 41 });
  });

  it("splits on the last dash, so an identifier may contain one", () => {
    assert.deepEqual(parseTaskRef("MY-TEAM-41"), { prefix: "MY-TEAM", index: 41 });
  });

  it("rejects a bare number and names the escape hatch", () => {
    assert.throws(() => parseTaskRef("41"), /\{ id: 41 \}/);
  });

  it("rejects the #index form a project without an identifier renders", () => {
    assert.throws(() => parseTaskRef("#41"), /global id/);
  });

  it("rejects malformed keys", () => {
    for (const input of ["", "   ", "INFRA-", "-41", "INFRA-abc", "INFRA 41", "INFRA-4.1"]) {
      assert.throws(() => parseTaskRef(input), /./, `accepted ${JSON.stringify(input)}`);
    }
  });

  it("rejects index 0, since numbering starts at 1", () => {
    assert.throws(() => parseTaskRef("INFRA-0"), /starts at 1/);
  });
});

describe("formatRef", () => {
  it("joins identifier and index", () => {
    assert.equal(formatRef("INFRA", 41), "INFRA-41");
  });

  it("falls back to #index for a project with no identifier", () => {
    assert.equal(formatRef("", 41), "#41");
  });
});

describe("Resolver", () => {
  it("resolves a key to the global id", async () => {
    const client = stubClient(PROJECTS, TASKS);
    assert.equal(await new Resolver(client).resolveTaskRef("INFRA-42"), 302);
  });

  it("resolves regardless of the case the key was typed in", async () => {
    const client = stubClient(PROJECTS, TASKS);
    assert.equal(await new Resolver(client).resolveTaskRef("infra-41"), 301);
  });

  it("resolves a project key on its own", async () => {
    const client = stubClient(PROJECTS, TASKS);
    assert.equal(await new Resolver(client).resolveProjectKey("vmcp"), 11);
  });

  it("caches the project map across calls", async () => {
    const client = stubClient(PROJECTS, TASKS);
    const resolver = new Resolver(client);

    await resolver.resolveTaskRef("INFRA-41");
    await resolver.resolveTaskRef("VMCP-1");

    assert.equal(client.calls.listProjects, 1);
  });

  it("shares one project load between concurrent calls", async () => {
    const client = stubClient(PROJECTS, TASKS);
    const resolver = new Resolver(client);

    await Promise.all([resolver.resolveTaskRef("INFRA-41"), resolver.resolveTaskRef("VMCP-1")]);

    assert.equal(client.calls.listProjects, 1);
  });

  it("reloads once when a prefix is missing, picking up a project created since", async () => {
    const projects = [...PROJECTS];
    const client = stubClient(projects, [...TASKS, task(900, 12, 1)]);
    const resolver = new Resolver(client);

    await resolver.resolveTaskRef("INFRA-41");
    projects.push(project(12, "NEW"));

    assert.equal(await resolver.resolveTaskRef("NEW-1"), 900);
    assert.equal(client.calls.listProjects, 2);
  });

  it("reports an unknown prefix after exactly one reload", async () => {
    const client = stubClient(PROJECTS, TASKS);

    await assert.rejects(() => new Resolver(client).resolveTaskRef("NOPE-1"), /No project/);
    assert.equal(client.calls.listProjects, 2);
  });

  it("refuses an ambiguous prefix rather than picking a project", async () => {
    const client = stubClient([project(7, "INFRA"), project(8, "infra")], TASKS);

    await assert.rejects(() => new Resolver(client).resolveTaskRef("INFRA-41"), /ambiguous/);
  });

  it("ignores projects that have no identifier", async () => {
    const client = stubClient([project(9, ""), ...PROJECTS], TASKS);

    assert.equal(await new Resolver(client).resolveTaskRef("INFRA-41"), 301);
  });

  it("reports a key whose index does not exist", async () => {
    const client = stubClient(PROJECTS, TASKS);

    await assert.rejects(
      () => new Resolver(client).resolveTaskRef("INFRA-99"),
      /no task with index/,
    );
  });

  it("errors instead of returning another task when the server ignores the index term", async () => {
    const client = stubClient(PROJECTS, TASKS, { honoursIndex: false });

    await assert.rejects(
      () => new Resolver(client).resolveTaskRef("INFRA-99"),
      /no task with index/,
    );
  });

  it("does not cache a failed project load", async () => {
    const client = stubClient(PROJECTS, TASKS, { failures: 1 });
    const resolver = new Resolver(client);

    await assert.rejects(() => resolver.resolveTaskRef("INFRA-41"), /boom/);
    assert.equal(await resolver.resolveTaskRef("INFRA-41"), 301);
  });
});
