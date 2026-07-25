/**
 * The stub below answers `project_id = N && index = M` because that is what the live server
 * does — checked against Vikunja 2.3.0, where the filter returns exactly the one task. The
 * `honoursIndex: false` mode is the same server with that term ignored, which is how an older
 * or newer build would behave and the one case where a wrong answer is worse than an error.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Resolver,
  type ResolverClient,
  formatRef,
  parseProjectKey,
  parseTaskRef,
} from "../src/resolver.ts";
import type { RawBucket, RawLabel, RawProject, RawTask, RawUser, RawView } from "../src/types.ts";

function project(id: number, identifier: string, isArchived = false): RawProject {
  return { id, title: `Project ${id}`, identifier, description: "", is_archived: isArchived };
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
    assignees: null,
  };
}

function user(id: number, username: string, name = ""): RawUser {
  return { id, username, name };
}

interface StubOptions {
  /** False emulates a server that drops the `index` term and answers with the whole project. */
  honoursIndex?: boolean;
  /** Number of leading `listProjects` calls that fail, to exercise cache recovery. */
  failures?: number;
  /** 1-based `listProjects` call numbers that fail, for a reload landing on a warm cache. */
  failOn?: number[];
  /** The instance's labels. Titles are not unique on a real server, and neither are these. */
  labels?: RawLabel[];
  /** The project's views, for the kanban-view lookup. */
  views?: RawView[];
  /** A manual view's buckets, for the column-name lookup. */
  buckets?: RawBucket[];
  /** The project's assignable members. Usernames collide case-insensitively on SQLite. */
  members?: RawUser[];
}

interface Stub extends ResolverClient {
  calls: { listProjects: number; listLabels: number; listProjectUsers: number; filters: string[] };
}

function stubClient(projects: RawProject[], tasks: RawTask[], options: StubOptions = {}): Stub {
  const calls = { listProjects: 0, listLabels: 0, listProjectUsers: 0, filters: [] as string[] };
  let failures = options.failures ?? 0;

  return {
    calls,
    listLabels: async () => {
      calls.listLabels++;
      return options.labels ?? [];
    },
    listViews: async () => options.views ?? [],
    listBuckets: async () => options.buckets ?? [],
    listProjectUsers: async () => {
      calls.listProjectUsers++;
      return options.members ?? [];
    },
    listProjects: async () => {
      calls.listProjects++;
      if (failures > 0) {
        failures--;
        throw new Error("boom");
      }
      if (options.failOn?.includes(calls.listProjects)) {
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

describe("parseProjectKey", () => {
  it("upper-cases and trims", () => {
    assert.equal(parseProjectKey("  infra "), "INFRA");
  });

  it("rejects a bare number and names the escape hatch", () => {
    // The rule that makes this worth having at all: Vikunja would look for a project whose
    // identifier is literally "11" and report it missing, which hides an id-for-key mix-up
    // behind a message about a project that does exist.
    assert.throws(() => parseProjectKey("11"), /\{ projectId: 11 \}/);
  });

  it("rejects an empty key", () => {
    assert.throws(() => parseProjectKey("   "), /A project key is required/);
  });

  it("rejects a key that is not an identifier", () => {
    for (const input of ["IN FRA", "INFRA!", "in.fra"]) {
      assert.throws(() => parseProjectKey(input), /not a project key/, `accepted ${input}`);
    }
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

/** Zero means "never too fresh to reload", which is the only way to reach the reload path. */
const ALWAYS_RELOAD = { reloadIntervalMs: 0 };

describe("Resolver", () => {
  it("resolves a key to the task itself, not merely its id", async () => {
    const client = stubClient(PROJECTS, TASKS);
    const resolved = await new Resolver(client).resolveTask("INFRA-42");

    assert.equal(resolved.id, 302);
    assert.equal(resolved.index, 42);
    assert.equal(resolved.title, "Task 302");
  });

  it("resolves in one request, without a second fetch for the task", async () => {
    const client = stubClient(PROJECTS, TASKS);

    await new Resolver(client).resolveTask("INFRA-42");

    assert.equal(client.calls.filters.length, 1);
  });

  it("resolves regardless of the case the key was typed in", async () => {
    const client = stubClient(PROJECTS, TASKS);
    assert.equal((await new Resolver(client).resolveTask("infra-41")).id, 301);
  });

  it("resolves a project key on its own", async () => {
    const client = stubClient(PROJECTS, TASKS);
    assert.equal(await new Resolver(client).resolveProjectKey("vmcp"), 11);
  });

  it("caches the project map across calls", async () => {
    const client = stubClient(PROJECTS, TASKS);
    const resolver = new Resolver(client);

    await resolver.resolveTask("INFRA-41");
    await resolver.resolveTask("VMCP-1");

    assert.equal(client.calls.listProjects, 1);
  });

  it("shares one project load between concurrent calls", async () => {
    const client = stubClient(PROJECTS, TASKS);
    const resolver = new Resolver(client);

    await Promise.all([resolver.resolveTask("INFRA-41"), resolver.resolveTask("VMCP-1")]);

    assert.equal(client.calls.listProjects, 1);
  });

  it("reloads when a prefix is missing, picking up a project created since", async () => {
    const projects = [...PROJECTS];
    const client = stubClient(projects, [...TASKS, task(900, 12, 1)]);
    const resolver = new Resolver(client, ALWAYS_RELOAD);

    await resolver.resolveTask("INFRA-41");
    projects.push(project(12, "NEW"));

    assert.equal((await resolver.resolveTask("NEW-1")).id, 900);
    assert.equal(client.calls.listProjects, 2);
  });

  it("reports an unknown prefix after one reload", async () => {
    const client = stubClient(PROJECTS, TASKS);

    await assert.rejects(
      () => new Resolver(client, ALWAYS_RELOAD).resolveTask("NOPE-1"),
      /No project/,
    );
    assert.equal(client.calls.listProjects, 2);
  });

  it("does not re-list projects for a prefix that just missed a freshly loaded map", async () => {
    const client = stubClient(PROJECTS, TASKS);
    const resolver = new Resolver(client);

    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(() => resolver.resolveTask("NOPE-1"), /No project/);
    }

    // One cold load and no reload: the map arrived moments ago, so re-listing cannot change the
    // answer. A mistyped key must not buy a listing per call.
    assert.equal(client.calls.listProjects, 1);
  });

  it("shares one reload between concurrent misses", async () => {
    const client = stubClient(PROJECTS, TASKS);
    const resolver = new Resolver(client, ALWAYS_RELOAD);

    await resolver.resolveTask("INFRA-41");
    const misses = await Promise.allSettled([
      resolver.resolveTask("A-1"),
      resolver.resolveTask("B-1"),
      resolver.resolveTask("C-1"),
    ]);

    assert.ok(misses.every((outcome) => outcome.status === "rejected"));
    assert.equal(client.calls.listProjects, 2);
  });

  it("keeps answering known prefixes when a reload fails", async () => {
    const client = stubClient(PROJECTS, TASKS, { failOn: [2] });
    const resolver = new Resolver(client, ALWAYS_RELOAD);

    await resolver.resolveTask("INFRA-41");
    // Someone else's typo triggers a reload that fails. The map already in hand still answers.
    await assert.rejects(() => resolver.resolveTask("NOPE-1"), /boom/);

    assert.equal((await resolver.resolveTask("INFRA-41")).id, 301);
  });

  it("refuses an ambiguous prefix rather than picking a project", async () => {
    const client = stubClient([project(7, "INFRA"), project(8, "infra")], TASKS);

    await assert.rejects(() => new Resolver(client).resolveTask("INFRA-41"), /ambiguous/);
  });

  it("points an ambiguous project key at a project id, not a task id", async () => {
    const client = stubClient([project(7, "INFRA"), project(8, "infra")], TASKS);

    await assert.rejects(
      () => new Resolver(client).resolveProjectKey("INFRA"),
      /Address the project by its id: one of 7, 8/,
    );
  });

  it("ignores projects that have no identifier", async () => {
    const client = stubClient([project(9, ""), ...PROJECTS], TASKS);

    assert.equal((await new Resolver(client).resolveTask("INFRA-41")).id, 301);
  });

  it("reports a key whose index does not exist", async () => {
    const client = stubClient(PROJECTS, TASKS);

    await assert.rejects(() => new Resolver(client).resolveTask("INFRA-99"), /no task with index/);
  });

  it("blames the archive, not the index, for a task an archived project will not list", async () => {
    // Verified on 2.3.0: `GET /tasks` is built from the user's non-archived projects and takes
    // no parameter to widen that, so an archived project answers with nothing whatever the
    // filter says — while `GET /tasks/{id}` still returns the same task.
    const client = stubClient([project(20, "OLD", true)], []);

    await assert.rejects(
      () => new Resolver(client).resolveTask("OLD-1"),
      /is archived, and Vikunja does not list tasks of archived projects/,
    );
  });

  it("still resolves the key of a project that is not archived", async () => {
    const client = stubClient([project(7, "INFRA"), project(20, "OLD", true)], TASKS);

    assert.equal((await new Resolver(client).resolveTask("INFRA-41")).id, 301);
  });

  it("refuses to narrow a task query to an archived project", async () => {
    // The id resolves perfectly well; it is the query that cannot work. Handing it back would
    // produce an empty listing shaped exactly like "this project has no tasks", so the listing
    // path refuses with the same story `resolveTask` tells about the same project.
    const client = stubClient([project(20, "OLD", true)], []);

    await assert.rejects(
      () => new Resolver(client).resolveProjectForTasks("OLD"),
      /is archived, and Vikunja does not list tasks of archived projects/,
    );
  });

  it("narrows a task query to a live project", async () => {
    const client = stubClient(PROJECTS, TASKS);

    assert.equal(await new Resolver(client).resolveProjectForTasks("vmcp"), 11);
  });

  it("refuses a bare number on the task-query path too", async () => {
    const client = stubClient(PROJECTS, TASKS);

    await assert.rejects(
      () => new Resolver(client).resolveProjectForTasks("11"),
      /\{ projectId: 11 \}/,
    );
  });

  it("refuses a bare number on the plain project path, which write tools resolve through", async () => {
    const client = stubClient(PROJECTS, TASKS);

    await assert.rejects(() => new Resolver(client).resolveProjectKey("11"), /\{ projectId: 11 \}/);
  });

  it("refuses to narrow a task query to an archived project id", async () => {
    // The id escape hatch reached the same silent `[]` the key path used to, which would have
    // left one tool telling two stories about one project depending on which input it was given.
    const client = stubClient([project(20, "OLD", true)], []);

    await assert.rejects(
      () => new Resolver(client).checkProjectIdForTasks(20),
      /is archived, and Vikunja does not list tasks of archived projects/,
    );
  });

  it("accepts the id of a live project", async () => {
    const client = stubClient(PROJECTS, TASKS);

    assert.equal(await new Resolver(client).checkProjectIdForTasks(11), 11);
  });

  it("accepts the id of a project with no key, which is what the id hatch is for", async () => {
    // The key map skips these; the id map must not, or the check would refuse exactly the
    // projects the escape hatch exists to reach.
    const client = stubClient([project(10, ""), ...PROJECTS], TASKS);

    assert.equal(await new Resolver(client).checkProjectIdForTasks(10), 10);
  });

  it("refuses an id that names no project rather than letting it answer empty", async () => {
    const client = stubClient(PROJECTS, TASKS);

    await assert.rejects(
      () => new Resolver(client).checkProjectIdForTasks(999),
      /No project has id 999/,
    );
  });

  it("reloads for an unknown id, picking up a project created since", async () => {
    const projects = [...PROJECTS];
    const client = stubClient(projects, TASKS);
    const resolver = new Resolver(client, ALWAYS_RELOAD);

    await resolver.resolveProjectKey("INFRA");
    projects.push(project(12, "NEW"));

    assert.equal(await resolver.checkProjectIdForTasks(12), 12);
    assert.equal(client.calls.listProjects, 2);
  });

  it("errors instead of returning another task when the server ignores the index term", async () => {
    const client = stubClient(PROJECTS, TASKS, { honoursIndex: false });

    await assert.rejects(() => new Resolver(client).resolveTask("INFRA-99"), /no task with index/);
  });

  it("does not cache a failed project load", async () => {
    const client = stubClient(PROJECTS, TASKS, { failures: 1 });
    const resolver = new Resolver(client);

    await assert.rejects(() => resolver.resolveTask("INFRA-41"), /boom/);
    assert.equal((await resolver.resolveTask("INFRA-41")).id, 301);
  });
});

describe("Resolver.resolveLabelIds", () => {
  const LABELS: RawLabel[] = [
    { id: 1, title: "feature" },
    { id: 2, title: "bug" },
    { id: 5, title: "feature" },
  ];

  function labelResolver(labels = LABELS): Resolver {
    return new Resolver(stubClient(PROJECTS, TASKS, { labels }));
  }

  it("maps a title to its id, case-insensitively", async () => {
    assert.deepEqual(await labelResolver().resolveLabelIds(["BUG"]), [2]);
  });

  it("takes a number as a label id", async () => {
    assert.deepEqual(await labelResolver().resolveLabelIds([5]), [5]);
  });

  it("refuses a title two labels share rather than picking the lower id", async () => {
    await assert.rejects(
      () => labelResolver().resolveLabelIds(["feature"]),
      /belongs to 2 labels \(ids 1, 5\)/,
    );
  });

  it("reports a title no label carries", async () => {
    await assert.rejects(() => labelResolver().resolveLabelIds(["nope"]), /No label is titled/);
  });

  it("checks a label id against the listing, so nothing is written for a typo", async () => {
    await assert.rejects(() => labelResolver().resolveLabelIds([99]), /No label has id 99/);
  });

  it("collapses a label named twice, which the API would refuse the second time", async () => {
    assert.deepEqual(await labelResolver().resolveLabelIds(["bug", 2, " Bug "]), [2]);
  });

  it("does not list labels when a call carries none", async () => {
    const client = stubClient(PROJECTS, TASKS, { labels: LABELS });

    assert.deepEqual(await new Resolver(client).resolveLabelIds([]), []);
    assert.equal(client.calls.listLabels, 0);
  });

  it("resolves titles and ids in one call, keeping the order they were named in", async () => {
    const pipeline: RawLabel[] = [
      { id: 5, title: "feature" },
      { id: 45, title: "specified" },
    ];

    assert.deepEqual(
      await labelResolver(pipeline).resolveLabelIds(["specified", 5, "SPECIFIED"]),
      [45, 5],
    );
  });
});

/**
 * The incremental change `vikunja_label_task` lands: `(current ∪ add) \ remove`, computed from
 * the labels the task already carries so the whole set can go to the bulk endpoint in one write.
 *
 * The asymmetry between the two arguments is the point. An `add` names a label that may not be
 * on the task, so it is resolved instance-wide and an ambiguous title has to be refused. A
 * `remove` names one that is, so it is matched against the task's own labels — which is what
 * makes a title shared instance-wide unambiguous there, and a title the task does not carry a
 * no-op rather than an error.
 */
describe("Resolver.resolveLabelChange", () => {
  const LABELS: RawLabel[] = [
    { id: 2, title: "bug" },
    { id: 3, title: "bug" },
    { id: 5, title: "feature" },
    { id: 45, title: "specified" },
    { id: 46, title: "in-progress" },
  ];

  /** A task in the middle of the pipeline: one workflow label, one kind label. */
  const CURRENT: RawLabel[] = [
    { id: 5, title: "feature" },
    { id: 45, title: "specified" },
  ];

  function changeResolver(labels = LABELS): Resolver {
    return new Resolver(stubClient(PROJECTS, TASKS, { labels }));
  }

  it("adds one label and drops another in a single resulting set", async () => {
    const next = await changeResolver().resolveLabelChange(CURRENT, {
      add: ["in-progress"],
      remove: ["specified"],
    });

    assert.deepEqual(next, [5, 46]);
  });

  it("leaves the set unchanged when a label already on the task is re-added", async () => {
    const next = await changeResolver().resolveLabelChange(CURRENT, { add: ["feature"] });

    assert.deepEqual(next, [5, 45]);
  });

  it("leaves the set unchanged when a removal names a label the task does not carry", async () => {
    // Idempotent by construction: the set simply does not contain it, so nothing is asked of the
    // server. No error, and no per-label DELETE that would come back as a bare 403.
    const next = await changeResolver().resolveLabelChange(CURRENT, { remove: ["bug"] });

    assert.deepEqual(next, [5, 45]);
  });

  it("matches a removal against the task's own labels, so a shared title still names one", async () => {
    // "bug" is two labels instance-wide, which would be ambiguous on an add. On a remove it is
    // not: only one of them is on the task, and that is the one meant.
    const current: RawLabel[] = [
      { id: 2, title: "bug" },
      { id: 5, title: "feature" },
    ];

    const next = await changeResolver().resolveLabelChange(current, { remove: ["BUG"] });

    assert.deepEqual(next, [5], "dropped the bug the task carried, not the other one");
  });

  it("refuses an ambiguous title on the add side, where the instance is what is searched", async () => {
    await assert.rejects(
      () => changeResolver().resolveLabelChange(CURRENT, { add: ["bug"] }),
      /belongs to 2 labels \(ids 2, 3\)/,
    );
  });

  it("refuses a label named in both add and remove instead of picking an order", async () => {
    // Named two different ways — a title on one side, its id on the other — so the collision only
    // becomes visible once both sides are resolved.
    await assert.rejects(
      () => changeResolver().resolveLabelChange(CURRENT, { add: ["specified"], remove: [45] }),
      /both add and remove/,
    );
  });

  it("refuses the same title on both sides even when the task does not carry it", async () => {
    // The refusal must not depend on what the task happens to hold. Detecting the collision only
    // after matching the removal against `current` let this call through — attaching the very
    // label it was told to remove — and then throw on an identical second call, the opposite of
    // the idempotence the tool advertises.
    await assert.rejects(
      () =>
        changeResolver().resolveLabelChange(CURRENT, {
          add: ["in-progress"],
          remove: ["in-progress"],
        }),
      /both add and remove/,
    );
  });

  it("refuses the same label id on both sides even when the task does not carry it", async () => {
    await assert.rejects(
      () => changeResolver().resolveLabelChange(CURRENT, { add: [46], remove: [46] }),
      /both add and remove/,
    );
  });

  it("compares the sides as the titles are written, ignoring case and surrounding space", async () => {
    await assert.rejects(
      () =>
        changeResolver().resolveLabelChange(CURRENT, {
          add: ["In-Progress"],
          remove: [" in-progress "],
        }),
      /both add and remove/,
    );
  });

  it("reports a collision before resolving anything, so nothing is read for it", async () => {
    const client = stubClient(PROJECTS, TASKS, { labels: LABELS });

    await assert.rejects(
      () => new Resolver(client).resolveLabelChange(CURRENT, { add: ["nope"], remove: ["NOPE"] }),
      /both add and remove/,
      "the collision is what is reported, not the unknown label it would have resolved to",
    );
    assert.equal(client.calls.listLabels, 0);
  });

  it("answers a collision the same way whether or not the task carries the label", async () => {
    const resolver = changeResolver();
    const change = { add: ["specified"], remove: ["specified"] };

    await assert.rejects(() => resolver.resolveLabelChange(CURRENT, change), /both add and remove/);
    await assert.rejects(
      () => resolver.resolveLabelChange([{ id: 5, title: "feature" }], change),
      /both add and remove/,
    );
  });

  it("refuses a change that names no label at all, before reading anything", async () => {
    const client = stubClient(PROJECTS, TASKS, { labels: LABELS });

    await assert.rejects(
      () => new Resolver(client).resolveLabelChange(CURRENT, {}),
      /at least one label/,
    );
    await assert.rejects(
      () => new Resolver(client).resolveLabelChange(CURRENT, { add: [], remove: [] }),
      /at least one label/,
    );
    assert.equal(client.calls.listLabels, 0, "an empty change costs no request");
  });

  it("does not list the instance's labels for a removal, which needs only the task's", async () => {
    const client = stubClient(PROJECTS, TASKS, { labels: LABELS });

    await new Resolver(client).resolveLabelChange(CURRENT, { remove: ["specified"] });

    assert.equal(client.calls.listLabels, 0);
  });
});

describe("Resolver.resolveKanbanView", () => {
  function view(id: number, position: number, kind: string, mode: string): RawView {
    return { id, position, view_kind: kind, bucket_configuration_mode: mode };
  }

  it("returns the first kanban view by position, with its mode", async () => {
    const client = stubClient(PROJECTS, TASKS, {
      views: [
        view(43, 3, "table", "none"),
        view(44, 4, "kanban", "filter"),
        view(40, 1, "list", "none"),
        view(45, 2, "kanban", "manual"),
      ],
    });

    // 45 sits at position 2, ahead of 44 at position 4 — the first kanban by display order.
    assert.deepEqual(await new Resolver(client).resolveKanbanView(11), { id: 45, mode: "manual" });
  });

  it("treats a mode that is not manual as filter, so a move refuses rather than guesses", async () => {
    const client = stubClient(PROJECTS, TASKS, { views: [view(44, 1, "kanban", "filter")] });

    assert.equal((await new Resolver(client).resolveKanbanView(11)).mode, "filter");
  });

  it("errors when the project has no kanban view", async () => {
    const client = stubClient(PROJECTS, TASKS, {
      views: [view(40, 1, "list", "none"), view(43, 2, "table", "none")],
    });

    await assert.rejects(() => new Resolver(client).resolveKanbanView(11), /no kanban view/);
  });
});

describe("Resolver.resolveBucketId", () => {
  function bucket(id: number, title: string): RawBucket {
    return { id, title, tasks: null };
  }

  it("maps a column name to its bucket id, case-insensitively", async () => {
    const client = stubClient(PROJECTS, TASKS, {
      buckets: [bucket(7, "To-Do"), bucket(8, "Doing"), bucket(9, "Done")],
    });

    assert.equal(await new Resolver(client).resolveBucketId(3, 12, " doing "), 8);
  });

  it("lists the available columns when the name matches none", async () => {
    const client = stubClient(PROJECTS, TASKS, {
      buckets: [bucket(7, "To-Do"), bucket(9, "Done")],
    });

    await assert.rejects(
      () => new Resolver(client).resolveBucketId(3, 12, "Doing"),
      /no column named "Doing".*To-Do.*Done/s,
    );
  });

  it("reports an ambiguous column rather than picking one, and never leaks a bucket id", async () => {
    const client = stubClient(PROJECTS, TASKS, {
      buckets: [bucket(8, "Doing"), bucket(10, "Doing")],
    });

    await assert.rejects(
      () => new Resolver(client).resolveBucketId(3, 12, "Doing"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /2 columns named "Doing"/);
        assert.doesNotMatch(error.message, /\b8\b|\b10\b/);
        return true;
      },
    );
  });
});

describe("Resolver.resolveAssigneeIds", () => {
  const ALICE = user(3, "alice", "Alice A");
  const BOB = user(5, "bob");
  const MEMBERS = [ALICE, BOB];

  function memberStub(members: RawUser[] = MEMBERS): Stub {
    return stubClient(PROJECTS, TASKS, { members });
  }

  it("R3: maps a username to its id, case-insensitively", async () => {
    assert.deepEqual(await new Resolver(memberStub()).resolveAssigneeIds(11, [], ["ALICE"]), [3]);
  });

  it("R3: reports a username no member carries, pointing at the member listing", async () => {
    await assert.rejects(
      () => new Resolver(memberStub()).resolveAssigneeIds(11, [], ["carol"]),
      /No member of this project is called "carol".*vikunja_list_members/s,
    );
  });

  it("R3: refuses usernames that differ only in case, naming both ids, for either spelling", async () => {
    const collide = memberStub([user(3, "alice"), user(4, "Alice")]);

    for (const spelling of ["alice", "ALICE", "Alice"]) {
      await assert.rejects(
        () => new Resolver(collide).resolveAssigneeIds(11, [], [spelling]),
        /belongs to 2 users \(ids 3, 4\)/,
        `resolved ${spelling} instead of reporting the collision`,
      );
    }
  });

  it("R3: collapses the same user named by username and by id", async () => {
    assert.deepEqual(
      await new Resolver(memberStub()).resolveAssigneeIds(11, [], ["alice", 3]),
      [3],
    );
  });

  it("R3: passes an id through without gating it on the member listing", async () => {
    // Upstream's own listing has a hole — the owner of a parent project may be assigned but is
    // not listed — so gating an id here would be stricter than the server. Its access check is
    // the server's to make.
    const client = memberStub();

    assert.deepEqual(await new Resolver(client).resolveAssigneeIds(11, [], [9]), [9]);
    assert.equal(client.calls.listProjectUsers, 0, "no listing was needed to pass an id through");
  });

  it("R1: writes nothing for a user already assigned, whatever the spelling", async () => {
    const ids = await new Resolver(memberStub()).resolveAssigneeIds(11, [ALICE], ["alice", "bob"]);

    assert.deepEqual(ids, [5], "alice is already assigned, so only bob has to be written");
  });

  it("R1: skips an already-assigned user named by id, so the skip is on the id", async () => {
    assert.deepEqual(await new Resolver(memberStub()).resolveAssigneeIds(11, [ALICE], [3]), []);
  });

  it("does not list members when the call names nobody", async () => {
    const client = memberStub();

    assert.deepEqual(await new Resolver(client).resolveAssigneeIds(11, [], []), []);
    assert.equal(client.calls.listProjectUsers, 0);
  });

  it("lists members once however many usernames a call carries", async () => {
    const client = memberStub();

    await new Resolver(client).resolveAssigneeIds(11, [], ["alice", "bob"]);

    assert.equal(client.calls.listProjectUsers, 1);
  });
});

describe("Resolver.resolveUnassigneeIds", () => {
  const ALICE = user(3, "alice", "Alice A");
  const BOB = user(5, "bob");

  function resolver(members: RawUser[] = [ALICE, BOB]): Resolver {
    return new Resolver(stubClient(PROJECTS, TASKS, { members }));
  }

  it("R3: maps an assigned username to its id, case-insensitively", () => {
    assert.deepEqual(resolver().resolveUnassigneeIds([ALICE, BOB], ["ALICE"]), [3]);
  });

  it("R2: refuses a user who is not assigned, naming who is", () => {
    assert.throws(
      () => resolver().resolveUnassigneeIds([ALICE], ["bob"]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /"bob" is not assigned/);
        assert.match(error.message, /alice/, "names who is assigned instead of reporting success");
        return true;
      },
    );
  });

  it("R3: refuses an id that is not assigned, and resolves one that is", () => {
    assert.throws(() => resolver().resolveUnassigneeIds([ALICE], [9]), /alice/);
    assert.deepEqual(resolver().resolveUnassigneeIds([ALICE], [3]), [3]);
  });

  it("R2: resolves an assignee who is no longer a project member", () => {
    // The candidate set is the task's own assignees, so an ex-member stays removable — and no
    // member listing is consulted at all.
    const client = stubClient(PROJECTS, TASKS, { members: [BOB] });

    assert.deepEqual(new Resolver(client).resolveUnassigneeIds([ALICE], ["alice"]), [3]);
    assert.equal(client.calls.listProjectUsers, 0);
  });

  it("R3: refuses two assignees whose usernames differ only in case", () => {
    const assigned = [user(3, "alice"), user(4, "Alice")];

    assert.throws(
      () => resolver().resolveUnassigneeIds(assigned, ["alice"]),
      /belongs to 2 users \(ids 3, 4\)/,
    );
  });

  it("collapses the same user named twice", () => {
    assert.deepEqual(resolver().resolveUnassigneeIds([ALICE], ["alice", 3, " ALICE "]), [3]);
  });

  it("R2: says so when the task has no assignees at all", () => {
    assert.throws(() => resolver().resolveUnassigneeIds([], ["alice"]), /no assignees/);
  });
});
