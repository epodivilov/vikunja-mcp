/**
 * The relate / unrelate data paths, composed from the real `Resolver`, `VikunjaClient`, the
 * shared `resolveTaskTarget` and the projection — the exact layers `vikunja_relate_tasks` and
 * `vikunja_unrelate_tasks` wire together — over one routing `fetch`.
 *
 * The two tool files themselves cannot be imported under `node --test`: like every tool in this
 * repo they import values by `.js` specifier, which the type-stripping loader will not resolve
 * to `.ts`. So `relate` and `unrelate` below repeat the tool bodies line for line, and what is
 * proved here is that those lines fit together — not that the registered tool runs them.
 * Everything the helpers do beyond glue — the kind vocabulary, key resolution, the ref lookup,
 * the projection — is imported from the module that owns it, so a change there fails these tests.
 *
 * The stub writes the inverse relation itself, the way Vikunja's `Create` does, and drops both
 * directions on a DELETE. That is what makes "exactly one PUT" a meaningful assertion rather
 * than a description of the stub.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VikunjaClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { relatedProjectIds, toLeanTaskDetail } from "../src/projection.ts";
import { Resolver } from "../src/resolver.ts";
import { OTHER_TASK_NAMES, type TaskTarget, resolveTaskTarget } from "../src/tools/task-target.ts";
import {
  type LeanTaskDetail,
  RELATION_KINDS,
  type RawProject,
  type RawTask,
  type RelationKind,
  parseRelationKind,
} from "../src/types.ts";

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

const INFRA_TASK = rawTask(530, 3, 3, "INFRA-3");
const INFRA_OTHER = rawTask(531, 3, 4, "INFRA-4");
const VMCP_TASK = rawTask(600, 11, 3, "VMCP-3");
const ALL_TASKS: RawTask[] = [INFRA_TASK, INFRA_OTHER, VMCP_TASK];

/** `DUP` and `dup` both exist, because Vikunja's identifier uniqueness is case-sensitive. */
const PROJECTS: RawProject[] = [
  rawProject(3, "INFRA"),
  rawProject(11, "VMCP"),
  rawProject(30, "DUP"),
  rawProject(31, "dup"),
];

/** What the server writes alongside every relation, and drops alongside it. */
const INVERSE: Record<string, string> = {
  subtask: "parenttask",
  parenttask: "subtask",
  related: "related",
  duplicateof: "duplicates",
  duplicates: "duplicateof",
  blocking: "blocked",
  blocked: "blocking",
  precedes: "follows",
  follows: "precedes",
  copiedfrom: "copiedto",
  copiedto: "copiedfrom",
};

interface StoredRelation {
  taskId: number;
  kind: string;
  otherId: number;
}

interface Stack {
  client: VikunjaClient;
  resolver: Resolver;
  calls: RecordedCall[];
  relations: StoredRelation[];
}

/**
 * One routing fetch answering every endpoint the two flows touch. `GET /tasks/{id}` embeds
 * `related_tasks` the way `ReadOne` does — full task rows whose `identifier` the server never
 * fills in, which is why a projection that read that field would answer with empty refs.
 */
function stack(seed: StoredRelation[] = []): Stack {
  const calls: RecordedCall[] = [];
  const relations: StoredRelation[] = [...seed];

  const embed = (taskId: number): Record<string, RawTask[]> | undefined => {
    const mine = relations.filter((relation) => relation.taskId === taskId);
    if (mine.length === 0) {
      return undefined;
    }

    const related: Record<string, RawTask[]> = {};
    for (const relation of mine) {
      const other = ALL_TASKS.find((task) => task.id === relation.otherId);
      if (other === undefined) {
        continue;
      }
      // The embedded copy carries no identifier: `setIdentifier` runs on the task being read
      // and never on the tasks inside `related_tasks` (go-vikunja 2.3.0, tasks.go).
      const ofKind = related[relation.kind] ?? [];
      ofKind.push({ ...other, identifier: "" });
      related[relation.kind] = ofKind;
    }

    return related;
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

    const relate = /^\/api\/v1\/tasks\/(\d+)\/relations$/.exec(path);
    if (method === "PUT" && relate) {
      const taskId = Number(relate[1]);
      const payload = body as { other_task_id?: number; relation_kind?: string };
      const kind = payload.relation_kind ?? "";
      const otherId = payload.other_task_id ?? 0;
      // Both directions, in one call, exactly as the server writes them.
      relations.push({ taskId, kind, otherId });
      relations.push({ taskId: otherId, kind: INVERSE[kind] ?? kind, otherId: taskId });
      return json({ task_id: taskId, other_task_id: otherId, relation_kind: kind });
    }

    const unrelate = /^\/api\/v1\/tasks\/(\d+)\/relations\/([a-z]+)\/(\d+)$/.exec(path);
    if (method === "DELETE" && unrelate) {
      const taskId = Number(unrelate[1]);
      const kind = unrelate[2] ?? "";
      const otherId = Number(unrelate[3]);
      const inverse = INVERSE[kind] ?? kind;
      const remaining = relations.filter(
        (relation) =>
          !(relation.taskId === taskId && relation.kind === kind && relation.otherId === otherId) &&
          !(
            relation.taskId === otherId &&
            relation.kind === inverse &&
            relation.otherId === taskId
          ),
      );
      relations.length = 0;
      relations.push(...remaining);
      return new Response(null, { status: 204 });
    }

    const taskById = /^\/api\/v1\/tasks\/(\d+)$/.exec(path);
    if (method === "GET" && taskById) {
      const wanted = Number(taskById[1]);
      const task = ALL_TASKS.find((row) => row.id === wanted);
      if (task === undefined) {
        return new Response(JSON.stringify({ code: 3005, message: "task does not exist" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return json({ ...task, related_tasks: embed(wanted) ?? null });
    }

    throw new Error(`unrouted ${method} ${path}`);
  }) as typeof globalThis.fetch;

  const client = new VikunjaClient(config, { fetch });
  return { client, resolver: new Resolver(client), calls, relations };
}

/** The second task's own arguments, kept distinct from the named task's `task`/`id`. */
interface OtherTarget {
  otherTask?: string;
  otherId?: number;
}

/** The relate_tasks body: validate the kind, resolve both sides, one write, read back. */
async function relate(
  { client, resolver }: Stack,
  target: TaskTarget,
  other: OtherTarget,
  kind: string,
): Promise<LeanTaskDetail> {
  const relation = parseRelationKind(kind);
  const named = await resolveTaskTarget(client, resolver, target);
  const counterpart = await resolveTaskTarget(
    client,
    resolver,
    { task: other.otherTask, id: other.otherId },
    OTHER_TASK_NAMES,
  );

  await client.createRelation(named.id, counterpart.id, relation);

  const read = await client.getTask(named.id);
  return toLeanTaskDetail(read, await resolver.taskRefLookup(relatedProjectIds(read)));
}

/** The unrelate_tasks body: the same, with the delete in place of the create. */
async function unrelate(
  { client, resolver }: Stack,
  target: TaskTarget,
  other: OtherTarget,
  kind: string,
): Promise<LeanTaskDetail> {
  const relation = parseRelationKind(kind);
  const named = await resolveTaskTarget(client, resolver, target);
  const counterpart = await resolveTaskTarget(
    client,
    resolver,
    { task: other.otherTask, id: other.otherId },
    OTHER_TASK_NAMES,
  );

  await client.deleteRelation(named.id, relation, counterpart.id);

  const read = await client.getTask(named.id);
  return toLeanTaskDetail(read, await resolver.taskRefLookup(relatedProjectIds(read)));
}

const writes = (calls: RecordedCall[]): RecordedCall[] =>
  calls.filter((call) => call.method === "PUT" || call.method === "DELETE");

describe("relate_tasks data path", () => {
  it("R1: two keys -> two ids -> one PUT carrying those ids and the kind", async () => {
    const layers = stack();

    await relate(layers, { task: "INFRA-3" }, { otherTask: "VMCP-3" }, "blocking");

    const puts = layers.calls.filter((call) => call.method === "PUT");
    assert.equal(puts.length, 1, "the inverse relation is the server's write, not a second one");
    const [put] = puts;
    assert.ok(put);
    assert.equal(put.path, "/api/v1/tasks/530/relations");
    assert.deepEqual(put.body, { other_task_id: 600, relation_kind: "blocking" });
  });

  it("R1: answers with the named task and its relations, both named by key", async () => {
    const layers = stack();

    const answer = await relate(layers, { task: "INFRA-3" }, { otherTask: "VMCP-3" }, "blocking");

    assert.equal(answer.ref, "INFRA-3");
    assert.deepEqual(answer.relations, [
      { kind: "blocking", ref: "VMCP-3", title: "Task 600", done: false },
    ]);
  });

  it("R1: the inverse the server wrote is what the other task reads back", async () => {
    const layers = stack();

    await relate(layers, { task: "INFRA-3" }, { otherTask: "VMCP-3" }, "blocking");
    const other = await layers.client.getTask(600);

    assert.deepEqual(
      toLeanTaskDetail(other, await layers.resolver.taskRefLookup(relatedProjectIds(other)))
        .relations,
      [{ kind: "blocked", ref: "INFRA-3", title: "Task 530", done: false }],
    );
  });

  it("R1: relates two tasks of the same project just as readily", async () => {
    const layers = stack();

    const answer = await relate(layers, { task: "INFRA-3" }, { otherTask: "INFRA-4" }, "subtask");

    assert.deepEqual(answer.relations, [
      { kind: "subtask", ref: "INFRA-4", title: "Task 531", done: false },
    ]);
  });

  it("R2: an unknown kind is refused before anything is read or written", async () => {
    const layers = stack();

    await assert.rejects(
      () => relate(layers, { task: "INFRA-3" }, { otherTask: "VMCP-3" }, "blocks"),
      /blocks/,
    );
    assert.equal(layers.calls.length, 0, "no request at all — not even the project listing");
  });

  it("R3: an other-task key no project claims errors with nothing written", async () => {
    const layers = stack();

    await assert.rejects(
      () => relate(layers, { task: "INFRA-3" }, { otherTask: "NOPE-1" }, "blocking"),
      /No project has the key "NOPE"/,
    );
    assert.deepEqual(writes(layers.calls), [], "nothing was written");
  });

  it("R3: an other-task key two projects claim is refused rather than picked", async () => {
    const layers = stack();

    await assert.rejects(
      () => relate(layers, { task: "INFRA-3" }, { otherTask: "DUP-1" }, "blocking"),
      /ambiguous/,
    );
    assert.deepEqual(writes(layers.calls), [], "nothing was written");
  });

  it("R3: a bare number as the other task names the escape hatch, and writes nothing", async () => {
    const layers = stack();

    await assert.rejects(
      () => relate(layers, { task: "INFRA-3" }, { otherTask: "600" }, "blocking"),
      /\{ id: 600 \}/,
    );
    assert.deepEqual(writes(layers.calls), [], "nothing was written");
  });

  it("R3: a named task that cannot be resolved errors before the other side is even read", async () => {
    const layers = stack();

    await assert.rejects(
      () => relate(layers, { task: "NOPE-1" }, { otherTask: "VMCP-3" }, "blocking"),
      /No project has the key "NOPE"/,
    );
    assert.deepEqual(writes(layers.calls), [], "nothing was written");
  });

  it("R4: a refusal from the server surfaces as an error, not as a success", async () => {
    const layers = stack();
    // The task is related to itself, which Vikunja refuses with code 4004. The stub answers the
    // way the server does; the point is that nothing here swallows it.
    const refusing = new VikunjaClient(config, {
      fetch: (async () =>
        new Response(JSON.stringify({ code: 4004, message: "cannot relate a task to itself" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
    });

    await assert.rejects(
      () => refusing.createRelation(530, 530, "related"),
      /cannot relate a task to itself/,
    );
    assert.deepEqual(layers.relations, [], "no relation was recorded");
  });
});

describe("unrelate_tasks data path", () => {
  const seeded = (): StoredRelation[] => [
    { taskId: 530, kind: "blocking", otherId: 600 },
    { taskId: 600, kind: "blocked", otherId: 530 },
  ];

  it("R5: two keys -> two ids -> one DELETE naming the kind and the other task", async () => {
    const layers = stack(seeded());

    await unrelate(layers, { task: "INFRA-3" }, { otherTask: "VMCP-3" }, "blocking");

    const deletes = layers.calls.filter((call) => call.method === "DELETE");
    assert.equal(deletes.length, 1);
    const [call] = deletes;
    assert.ok(call);
    assert.equal(call.path, "/api/v1/tasks/530/relations/blocking/600");
  });

  it("R5: answers with the named task, whose relations are now gone", async () => {
    const layers = stack(seeded());

    const answer = await unrelate(layers, { task: "INFRA-3" }, { otherTask: "VMCP-3" }, "blocking");

    assert.equal(answer.ref, "INFRA-3");
    assert.equal("relations" in answer, false, "a task with no relations carries no field");
  });

  it("R5: the server drops the inverse too, so the other task loses it as well", async () => {
    const layers = stack(seeded());

    await unrelate(layers, { task: "INFRA-3" }, { otherTask: "VMCP-3" }, "blocking");
    const other = await layers.client.getTask(600);

    assert.deepEqual(layers.relations, [], "both directions gone");
    assert.equal(
      "relations" in
        toLeanTaskDetail(other, await layers.resolver.taskRefLookup(relatedProjectIds(other))),
      false,
    );
  });

  it("R2: an unknown kind is refused here too, before anything is read", async () => {
    const layers = stack(seeded());

    await assert.rejects(
      () => unrelate(layers, { task: "INFRA-3" }, { otherTask: "VMCP-3" }, "unknown"),
      /unknown/,
    );
    assert.equal(layers.calls.length, 0);
  });

  it("R3: an unresolvable other task errors with nothing deleted", async () => {
    const layers = stack(seeded());

    await assert.rejects(
      () => unrelate(layers, { task: "INFRA-3" }, { otherTask: "NOPE-1" }, "blocking"),
      /No project has the key "NOPE"/,
    );
    assert.deepEqual(writes(layers.calls), []);
    assert.equal(layers.relations.length, 2, "the relation is still there");
  });
});

describe("relation kinds", () => {
  it("R2: carries Vikunja's eleven valid kinds, and not `unknown`", () => {
    assert.deepEqual([...RELATION_KINDS].sort(), [
      "blocked",
      "blocking",
      "copiedfrom",
      "copiedto",
      "duplicateof",
      "duplicates",
      "follows",
      "parenttask",
      "precedes",
      "related",
      "subtask",
    ]);
    assert.equal(RELATION_KINDS.length, 11);
    assert.equal((RELATION_KINDS as readonly string[]).includes("unknown"), false);
  });

  it("R2: accepts every kind it advertises", () => {
    for (const kind of RELATION_KINDS) {
      assert.equal(parseRelationKind(kind), kind);
    }
  });

  it("R2: names the allowed kinds when it refuses one", () => {
    assert.throws(
      () => parseRelationKind("blocks"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        for (const kind of RELATION_KINDS) {
          assert.ok(error.message.includes(kind), `the refusal names ${kind}`);
        }
        return true;
      },
    );
  });

  it("R2: refuses `unknown`, which the server's own isValid() rejects", () => {
    assert.throws(() => parseRelationKind("unknown"), /unknown/);
  });

  it("R2: refuses an empty kind", () => {
    assert.throws(() => parseRelationKind("   "), /kind/);
  });

  it("R2: takes the vocabulary as the UI spells it, whatever case it arrives in", () => {
    const kinds: RelationKind[] = [parseRelationKind(" Blocking "), parseRelationKind("SUBTASK")];
    assert.deepEqual(kinds, ["blocking", "subtask"]);
  });
});

describe("the other task's own target fields", () => {
  const layers = (): Stack => stack();

  it("R3: names otherTask when neither field was passed", async () => {
    const { client, resolver } = layers();

    await assert.rejects(
      () => resolveTaskTarget(client, resolver, {}, OTHER_TASK_NAMES),
      /otherTask/,
    );
  });

  it("R3: names otherId when both were passed", async () => {
    const { client, resolver } = layers();

    await assert.rejects(
      () => resolveTaskTarget(client, resolver, { task: "VMCP-3", id: 600 }, OTHER_TASK_NAMES),
      /otherId/,
    );
  });

  it("R3: the named task keeps the plain task/id spelling", async () => {
    const { client, resolver } = layers();

    await assert.rejects(
      () => resolveTaskTarget(client, resolver, {}),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /\{ task: "INFRA-41" \}/);
        assert.doesNotMatch(error.message, /otherTask/);
        return true;
      },
    );
  });

  it("R3: resolves the other task by its global id when that is all there is", async () => {
    const { client, resolver } = layers();

    const resolved = await resolveTaskTarget(client, resolver, { id: 600 }, OTHER_TASK_NAMES);

    assert.equal(resolved.id, 600);
  });
});
