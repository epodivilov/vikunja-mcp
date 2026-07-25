/**
 * End-to-end coverage of the three assignee data paths — assign, unassign, and create-with-
 * assignees — composed from the real `Resolver`, `VikunjaClient` and projection, which are the
 * exact layers `vikunja_assign_task`, `vikunja_unassign_task` and `vikunja_create_task` wire
 * together, over a single routing `fetch`.
 *
 * The tool files themselves cannot be imported under `node --test` (VMCP-31: they import their
 * siblings by a `.js` specifier that does not exist on disk), so the helpers below RESTATE each
 * tool's body rather than importing it. That is worth being blunt about: what is proved here is
 * the data path — a key -> the task -> the names resolved -> the writes issued -> the read-back
 * projected. What it cannot prove is that the tool files perform those statements in that order;
 * that stays a matter for review and for the manual stdio runs.
 *
 * Unlike `test/board.test.ts`, whose routing fetch is stateless, this one APPLIES the writes to
 * its task fixture and reproduces the server's own refusals: 400/4021 for a user already
 * assigned, 403/7003 for a user without project access, and a DELETE that reports success whether
 * or not the assignment ever existed. Without that, every assertion about what an answer carries
 * would only be reading back the fixture the test author wrote.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VikunjaClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { toLeanTask, toTaskWrite } from "../src/projection.ts";
import { Resolver, type UserRef } from "../src/resolver.ts";
import type { LeanTask, RawProject, RawTask, RawUser } from "../src/types.ts";

const config: Config = { baseUrl: "http://vikunja.test/api/v1", token: "t0ken" };

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

const ALICE: RawUser = { id: 3, username: "alice", name: "Alice A" };
const BOB: RawUser = { id: 5, username: "bob", name: "" };

/** Everyone `GET /projects/11/projectusers` reports. Id 9 exists nowhere: the server's 403 case. */
const MEMBERS: RawUser[] = [ALICE, BOB];

const PROJECTS: RawProject[] = [
  { id: 11, title: "Project 11", identifier: "VMCP", description: "", is_archived: false },
];

function rawTask(id: number, index: number, assignees: RawUser[] | null): RawTask {
  return {
    id,
    project_id: 11,
    index,
    identifier: `VMCP-${index}`,
    title: `Task ${id}`,
    description: "",
    done: false,
    priority: 0,
    due_date: "0001-01-01T00:00:00Z",
    labels: null,
    assignees,
  };
}

interface Stack {
  client: VikunjaClient;
  resolver: Resolver;
  calls: RecordedCall[];
}

/**
 * One routing fetch over a mutable task fixture: VMCP-3 (id 600), assigned to alice.
 *
 * Every route answers the way Vikunja 2.3.0 does, including the parts that make our own rules
 * necessary — see the comments on each write.
 */
function stack(): Stack {
  const calls: RecordedCall[] = [];
  const tasks = new Map<number, RawTask>([[600, rawTask(600, 3, [ALICE])]]);
  let nextId = 601;
  let nextIndex = 4;

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
    const refusal = (status: number, code: number, message: string): Response =>
      new Response(JSON.stringify({ code, message }), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (method === "GET" && path === "/api/v1/projects") {
      return listing(PROJECTS);
    }

    // Not paginated on the real server: a bare array with no x-pagination-* headers at all.
    if (method === "GET" && path === "/api/v1/projects/11/projectusers") {
      return json(MEMBERS);
    }

    if (method === "GET" && path === "/api/v1/tasks") {
      const parsed = /project_id = (\d+) && index = (\d+)/.exec(
        url.searchParams.get("filter") ?? "",
      );
      const rows = parsed
        ? [...tasks.values()].filter(
            (task) => task.project_id === Number(parsed[1]) && task.index === Number(parsed[2]),
          )
        : [];
      return listing(rows);
    }

    const taskById = /^\/api\/v1\/tasks\/(\d+)$/.exec(path);
    if (method === "GET" && taskById) {
      return json(tasks.get(Number(taskById[1])) ?? null);
    }

    if (method === "PUT" && path === "/api/v1/projects/11/tasks") {
      const payload = body as { title: string; assignees?: { id: number }[] };
      const assigned = (payload.assignees ?? []).map((user) => {
        const member = MEMBERS.find((candidate) => candidate.id === user.id);
        if (member === undefined) {
          throw new Error(`the create path was handed a non-member id ${user.id}`);
        }
        return member;
      });
      const created = { ...rawTask(nextId++, nextIndex++, assigned), title: payload.title };
      tasks.set(created.id, created);

      // The create response is NOT the stored task: Vikunja ends createTask with
      // setTaskAssignees(assignees), echoing back the `[{ id: n }]` objects the request carried
      // — no username on them — and does not fill `identifier` in either. Projecting this
      // response would answer with a blank username and no key; the read-back is what makes both
      // real, so the stub has to lie exactly the way the server does.
      return json({
        ...created,
        identifier: "",
        assignees: (payload.assignees ?? []).map((user) => ({
          id: user.id,
          username: "",
          name: "",
        })),
      });
    }

    const assigneesOf = /^\/api\/v1\/tasks\/(\d+)\/assignees$/.exec(path);
    if (method === "PUT" && assigneesOf) {
      const task = tasks.get(Number(assigneesOf[1]));
      assert.ok(task, "assigned on a task the fixture knows");
      const userId = (body as { user_id: number }).user_id;
      const member = MEMBERS.find((candidate) => candidate.id === userId);

      // A user without project access is refused; canDoTaskAssingee -> CanWrite is the server's
      // check to make, which is why an id is never gated against the member listing locally.
      if (member === undefined) {
        return refusal(403, 7003, "You don't have the right to do that");
      }

      // An already-assigned user is refused too. Nothing here should ever see this: the resolver
      // drops them before the write. If it stops doing so, this refusal fails the call loudly
      // rather than letting a multi-user assign half-succeed.
      if ((task.assignees ?? []).some((candidate) => candidate.id === userId)) {
        return refusal(400, 4021, "The user is already assigned to this task");
      }

      task.assignees = [...(task.assignees ?? []), member];
      return json({ created: "2026-07-24T00:00:00Z" });
    }

    const assigneeOf = /^\/api\/v1\/tasks\/(\d+)\/assignees\/(\d+)$/.exec(path);
    if (method === "DELETE" && assigneeOf) {
      const task = tasks.get(Number(assigneeOf[1]));
      assert.ok(task, "unassigned on a task the fixture knows");
      const userId = Number(assigneeOf[2]);

      // TaskAssginee.Delete is a bare delete: it never checks that the assignment existed, so an
      // unassign of someone who was never assigned answers 200. That silent success is exactly
      // what the resolver's refusal exists to prevent.
      task.assignees = (task.assignees ?? []).filter((candidate) => candidate.id !== userId);
      return json({ message: "The assignee was successfully deleted." });
    }

    throw new Error(`unrouted ${method} ${path}`);
  }) as typeof globalThis.fetch;

  const client = new VikunjaClient(config, { fetch });
  return { client, resolver: new Resolver(client), calls };
}

/**
 * The assign_task body: resolve the task, resolve the names, write only the diff, read back.
 *
 * The writes go through `client.addTaskAssignees` rather than a loop written here, deliberately:
 * what an interrupted run reports is the behaviour under test below, and it lives in that method
 * — so this helper exercises the shipped code instead of restating it.
 */
async function assignTask(
  { client, resolver }: Stack,
  ref: string,
  users: readonly UserRef[],
): Promise<LeanTask> {
  const target = await resolver.resolveTask(ref);
  const ids = await resolver.resolveAssigneeIds(target.project_id, target.assignees ?? [], users);

  await client.addTaskAssignees(target.id, ids);

  return toLeanTask(await client.getTask(target.id));
}

/** The unassign_task body: the candidate set is the task's own assignees, not the member list. */
async function unassignTask(
  { client, resolver }: Stack,
  ref: string,
  users: readonly UserRef[],
): Promise<LeanTask> {
  const target = await resolver.resolveTask(ref);
  const ids = resolver.resolveUnassigneeIds(target.assignees ?? [], users);

  for (const id of ids) {
    await client.removeTaskAssignee(target.id, id);
  }

  return toLeanTask(await client.getTask(target.id));
}

/** The create_task body, assignee part: resolve before the task exists, then read the task back. */
async function createTask(
  { client, resolver }: Stack,
  projectId: number,
  title: string,
  users: readonly UserRef[],
): Promise<LeanTask> {
  const ids = await resolver.resolveAssigneeIds(projectId, [], users);
  const created = await client.createTask(projectId, toTaskWrite({ title }), ids);

  return toLeanTask(await client.getTask(created.id));
}

function assigneePuts(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method === "PUT" && /\/assignees$/.test(call.path));
}

describe("assign_task data path", () => {
  it("R1: writes only the user who is not assigned yet, and answers with both", async () => {
    const composed = stack();

    const answer = await assignTask(composed, "VMCP-3", ["alice", "bob"]);

    const puts = assigneePuts(composed.calls);
    assert.equal(puts.length, 1, "alice was already assigned, so only bob was written");
    assert.equal(puts[0]?.path, "/api/v1/tasks/600/assignees");
    assert.deepEqual(puts[0]?.body, { user_id: 5 });
    assert.deepEqual(answer.assignees, ["alice", "bob"], "the answer lists everyone now assigned");
  });

  it("R4: refuses the whole call when one name of several cannot be resolved", async () => {
    const composed = stack();

    await assert.rejects(
      () => assignTask(composed, "VMCP-3", ["alice", "nobody"]),
      /No member of this project is called "nobody"/,
    );

    assert.equal(assigneePuts(composed.calls).length, 0, "nothing was written");
  });

  it("R3: an id outside the project is sent, and the server's own refusal surfaces", async () => {
    const composed = stack();

    await assert.rejects(
      () => assignTask(composed, "VMCP-3", [9]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /7003/, "the server's code reaches the caller intact");
        return true;
      },
    );

    const puts = assigneePuts(composed.calls);
    assert.equal(puts.length, 1, "the id was not gated locally — the request was issued");
    assert.deepEqual(puts[0]?.body, { user_id: 9 });
  });

  it("R1: a refusal mid-call reports what already landed, not a bare failure", async () => {
    const composed = stack();

    // Two users, one of whom the server will refuse — and it cannot be known in advance, since a
    // user id is deliberately never gated on the member listing. bob's assignment lands first.
    await assert.rejects(
      () => assignTask(composed, "VMCP-3", ["bob", 9]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /user 5/, "names the assignment that landed");
        assert.match(error.message, /7003/, "the server's own refusal is still intact");
        return true;
      },
    );

    assert.deepEqual(
      assigneePuts(composed.calls).map((call) => call.body),
      [{ user_id: 5 }, { user_id: 9 }],
      "the first write reached the server before the refusal",
    );

    // The half-application is real, which is exactly why the error has to admit to it: an agent
    // told only "403" would either retry the whole call or report that nothing changed.
    const task = await composed.client.getTask(600);
    assert.deepEqual(
      (task.assignees ?? []).map((user) => user.username),
      ["alice", "bob"],
    );
  });
});

describe("unassign_task data path", () => {
  it("R2: removes the named assignee and answers with no assignees key left", async () => {
    const composed = stack();

    const answer = await unassignTask(composed, "VMCP-3", ["alice"]);

    const deletes = composed.calls.filter((call) => call.method === "DELETE");
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0]?.path, "/api/v1/tasks/600/assignees/3");
    assert.equal("assignees" in answer, false, "an empty assignee list is omitted, not sent as []");
  });

  it("R2: refuses a user who is not assigned, rather than a no-op DELETE the server accepts", async () => {
    const composed = stack();

    await assert.rejects(() => unassignTask(composed, "VMCP-3", ["bob"]), /alice/);

    assert.equal(
      composed.calls.filter((call) => call.method === "DELETE").length,
      0,
      "no DELETE reached the server",
    );
  });
});

describe("create_task assignee path", () => {
  it("R7: sends the assignees on the create and names them by username afterwards", async () => {
    const composed = stack();

    const answer = await createTask(composed, 11, "Ship it", ["ALICE"]);

    const create = composed.calls.find(
      (call) => call.method === "PUT" && call.path === "/api/v1/projects/11/tasks",
    );
    assert.ok(create, "issued the create");
    assert.deepEqual((create.body as { assignees: unknown }).assignees, [{ id: 3 }]);
    assert.deepEqual(answer.assignees, ["alice"]);
    assert.equal(answer.ref, "VMCP-4", "read back, so the key is the server's and not an echo");
    assert.ok(
      composed.calls.some((call) => call.method === "GET" && call.path === "/api/v1/tasks/601"),
      "the task was read back after the create",
    );
  });

  it("R7: the create response alone would answer with a blank username — hence the read-back", async () => {
    const composed = stack();

    // Exactly what the tool must NOT return. The server echoes the `[{ id }]` objects it was
    // handed, so projecting this response answers with an empty username and no key at all.
    const created = await composed.client.createTask(11, toTaskWrite({ title: "Ship it" }), [3]);

    assert.deepEqual(toLeanTask(created).assignees, [""]);
  });

  it("R7: an unresolvable name creates nothing at all", async () => {
    const composed = stack();

    await assert.rejects(
      () => createTask(composed, 11, "Ship it", ["alice", "nobody"]),
      /No member of this project is called "nobody"/,
    );

    assert.equal(
      composed.calls.filter((call) => call.method === "PUT").length,
      0,
      "no create was issued",
    );
  });
});
