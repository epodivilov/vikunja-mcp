/**
 * The label CRUD data paths, composed from the real `Resolver`, `VikunjaClient` and projection —
 * the exact layers `vikunja_create_label`, `vikunja_update_label` and `vikunja_delete_label` wire
 * together — over a single routing `fetch`.
 *
 * Nothing below is a transcription. The three tool bodies are `applyLabelCreate`,
 * `applyLabelUpdate` and `applyLabelDelete`, imported for real from `src/tools/label-fields.ts` —
 * whose only runtime import is zod — and the projection reaches them exactly as the tool files
 * hand it over, so a refusal deleted from one of those functions fails these tests instead of
 * shipping. A hand-mirrored copy of a tool body would pass whatever the tool then did; that is the
 * whole reason the bodies live there rather than in the registration files.
 *
 * What remains unproved here is what `src/tools/create-label.ts` and its two siblings still hold:
 * their schemas, descriptions and annotations, and the one binding each passes in (`toLabelWrite`
 * / `toLeanLabel`). Those files cannot be imported under `node --test` — they carry `.js` value
 * specifiers the type-stripping loader will not resolve to `.ts`.
 *
 * The stub reproduces the three server behaviours the design leans on, and each of them is a trap
 * a friendlier fake would hide:
 *
 * - `POST /labels/{id}` writes a fixed column set and zeroes what the payload omits, so a patch
 *   that forgot to merge blanks the fields it did not name.
 * - `PUT /labels` and `POST /labels/{id}` accept an empty title and a duplicate one; every
 *   refusal of those below is ours.
 * - `DELETE /labels/{id}` answers 200 and the tasks simply stop reporting the label.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VikunjaClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { toLabelWrite, toLeanLabel } from "../src/projection.ts";
import { type LabelRef, Resolver } from "../src/resolver.ts";
import {
  type DeletedLabel,
  type LabelProjection,
  applyLabelCreate,
  applyLabelDelete,
  applyLabelUpdate,
  checkLabelDeletable,
  checkLabelPatch,
} from "../src/tools/label-fields.ts";
import type { LabelFields, LeanLabel, RawLabel, RawTask } from "../src/types.ts";

/**
 * The projection exactly as the three tool files hand it over. Named here rather than inlined so
 * that "the tool passes the real thing" is one fact in one place — the only part of the wiring
 * these tests cannot see.
 */
const PROJECTION: LabelProjection = { toLabelWrite, toLeanLabel };

const config: Config = { baseUrl: "http://vikunja.test/api/v1", token: "t0ken" };

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

function label(id: number, title: string, hex_color = "", description = ""): RawLabel {
  return { id, title, description, hex_color };
}

function task(id: number, index: number, labels: RawLabel[]): RawTask {
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
    labels,
    assignees: null,
  };
}

const SPECIFIED = label(45, "specified", "0EA5E9", "groomed and ready");
const FEATURE = label(5, "feature", "e8e8e8");

/** The instance as these tests see it: distinct titles, which is what the real one has. */
const LABELS: RawLabel[] = [FEATURE, SPECIFIED, label(46, "in-progress")];

/**
 * One routing fetch over a mutable label store and a fixed set of tasks, recording every request.
 *
 * `tasks` are the ones that carry a label; the `GET /tasks` route answers the `labels in <id>`
 * filter the delete guard counts through, and nothing else — a query it cannot parse comes back
 * empty rather than answering a question it was not asked.
 */
function stack(
  labels: readonly RawLabel[] = LABELS,
  tasks: readonly RawTask[] = [],
): {
  client: VikunjaClient;
  resolver: Resolver;
  calls: RecordedCall[];
  stored: () => RawLabel[];
} {
  const calls: RecordedCall[] = [];
  const store: RawLabel[] = labels.map((entry) => ({ ...entry }));
  const taskStore: RawTask[] = tasks.map((entry) => structuredClone(entry));
  let nextId = 100;

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

    if (method === "GET" && path === "/api/v1/labels") {
      return listing(store.map((entry) => ({ ...entry })));
    }

    if (method === "PUT" && path === "/api/v1/labels") {
      // The server takes whatever title it is handed, empty or duplicated, and normalises the
      // colour it stores. Nothing here refuses anything.
      const patch = body as Partial<RawLabel>;
      const created: RawLabel = {
        id: nextId++,
        title: patch.title ?? "",
        description: patch.description ?? "",
        hex_color: (patch.hex_color ?? "").replace(/^#/, "").slice(0, 6),
      };
      store.push(created);
      return new Response(JSON.stringify(created), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }

    if (method === "GET" && path === "/api/v1/tasks") {
      const filter = url.searchParams.get("filter") ?? "";
      const parsed = /^labels in (\d+)$/.exec(filter);
      if (parsed === null) {
        return listing([]);
      }
      const wanted = Number(parsed[1]);
      return listing(
        taskStore.filter((entry) => (entry.labels ?? []).some((one) => one.id === wanted)),
      );
    }

    const one = /^\/api\/v1\/labels\/(\d+)$/.exec(path);
    if (one) {
      const id = Number(one[1]);
      const index = store.findIndex((entry) => entry.id === id);

      if (index === -1) {
        return new Response(JSON.stringify({ code: 8002, message: "label does not exist" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      if (method === "POST") {
        // `Label.Update` writes Cols("title", "description", "hex_color"): every one of those is
        // taken from the payload, and an omitted one is written as its zero value.
        const patch = body as Partial<RawLabel>;
        const updated: RawLabel = {
          id,
          title: patch.title ?? "",
          description: patch.description ?? "",
          hex_color: (patch.hex_color ?? "").replace(/^#/, "").slice(0, 6),
        };
        store[index] = updated;
        return json({ ...updated });
      }

      if (method === "DELETE") {
        store.splice(index, 1);
        // The label_tasks rows survive; the tasks simply stop reporting a label the read can no
        // longer join. What the caller observes is a detachment, which is what it is worded as.
        for (const entry of taskStore) {
          entry.labels = (entry.labels ?? []).filter((carried) => carried.id !== id);
        }
        return new Response("", { status: 200 });
      }
    }

    throw new Error(`unrouted ${method} ${path}`);
  }) as typeof globalThis.fetch;

  const client = new VikunjaClient(config, { fetch });
  return {
    client,
    resolver: new Resolver(client),
    calls,
    stored: () => store.map((entry) => ({ ...entry })),
  };
}

/**
 * The three shipped tool bodies, called with the projection the tool files pass. Thin wrappers so
 * a case reads as the tool call it stands for — the work is `applyLabel*`, not anything here.
 */
function createLabel(
  client: VikunjaClient,
  resolver: Resolver,
  title: string,
  color?: string,
): Promise<LeanLabel> {
  return applyLabelCreate(client, resolver, PROJECTION, { title, color });
}

function updateLabel(
  client: VikunjaClient,
  resolver: Resolver,
  ref: LabelRef,
  fields: LabelFields,
): Promise<LeanLabel> {
  return applyLabelUpdate(client, resolver, PROJECTION, ref, fields);
}

function deleteLabel(
  client: VikunjaClient,
  resolver: Resolver,
  ref: LabelRef,
  force = false,
): Promise<DeletedLabel> {
  return applyLabelDelete(client, resolver, ref, force);
}

describe("Resolver.resolveLabel", () => {
  it("R6: matches a title trimmed and case-insensitively, as every title match here does", async () => {
    const { resolver } = stack();

    assert.deepEqual(await resolver.resolveLabel("SPECIFIED "), SPECIFIED);
  });

  it("R6: takes a number as the label id and answers with the whole label", async () => {
    const { resolver } = stack();

    assert.deepEqual(await resolver.resolveLabel(5), FEATURE);
  });

  it("R6: reports a title no label carries", async () => {
    const { resolver } = stack();

    await assert.rejects(() => resolver.resolveLabel("bug"), /No label is titled "bug"/);
  });

  it("R6: refuses a title two labels share, naming both ids", async () => {
    const { resolver } = stack([...LABELS, label(2, "bug"), label(3, "bug")]);

    await assert.rejects(
      () => resolver.resolveLabel("bug"),
      /belongs to 2 labels \(ids 2, 3\)/,
      "an ambiguous title names the ids to choose between rather than picking the lower one",
    );
  });

  it("R6: reports an id no label has", async () => {
    const { resolver } = stack();

    await assert.rejects(() => resolver.resolveLabel(99), /No label has id 99/);
  });

  it("R6: costs exactly one labels listing, target and title check together", async () => {
    const { resolver, calls } = stack();

    await resolver.resolveLabel(45, "renamed");

    assert.equal(
      calls.filter((call) => call.method === "GET" && call.path === "/api/v1/labels").length,
      1,
      "resolving the target and checking the new title share one listing",
    );
  });
});

describe("create_label data path", () => {
  it("R1/R2: a title and a colour become one PUT, and the answer is the lean label", async () => {
    const { client, resolver, calls, stored } = stack();

    const created = await createLabel(client, resolver, "vmcp23-probe", "#00FF00");

    const writes = calls.filter((call) => call.method === "PUT");
    assert.equal(writes.length, 1, "one write");
    assert.equal(writes[0]?.path, "/api/v1/labels");
    assert.deepEqual(
      writes[0]?.body,
      { title: "vmcp23-probe", hex_color: "00ff00" },
      "the colour is normalised before it is sent, never after",
    );
    assert.deepEqual(created, { id: 100, title: "vmcp23-probe", color: "00ff00" });
    assert.equal(stored().at(-1)?.hex_color, "00ff00");
  });

  it("R1: refuses a whitespace-only title before any request", async () => {
    const { client, resolver, calls } = stack();

    await assert.rejects(() => createLabel(client, resolver, " "), /title/i);
    assert.equal(calls.length, 0, "the server would have accepted it; nothing was asked of it");
  });

  it("R2: an empty colour is not a refusal — the label is simply created without one", async () => {
    const { client, resolver, calls } = stack();

    const created = await createLabel(client, resolver, "vmcp23-probe", "");

    assert.deepEqual(created, { id: 100, title: "vmcp23-probe" });
    assert.equal("color" in created, false);
    assert.deepEqual(calls.filter((call) => call.method === "PUT")[0]?.body, {
      title: "vmcp23-probe",
      hex_color: "",
    });
  });

  it("R4: refuses a title another label already holds, naming its id, and writes nothing", async () => {
    const { client, resolver, calls } = stack();

    await assert.rejects(
      () => createLabel(client, resolver, " Feature"),
      /id 5/,
      "compared the way titles are addressed: trimmed and case-insensitively",
    );
    assert.ok(!calls.some((call) => call.method === "PUT"), "no label was created");
  });
});

describe("update_label data path", () => {
  it("R3: a recolour leaves every field the call did not name exactly as it was", async () => {
    const { client, resolver, calls, stored } = stack();

    const updated = await updateLabel(client, resolver, "specified", { color: "ff0000" });

    const post = calls.find((call) => call.method === "POST");
    assert.ok(post, "issued the update");
    assert.equal(post.path, "/api/v1/labels/45");
    assert.equal(
      (post.body as RawLabel).description,
      "groomed and ready",
      "the description no tool exposes still rode along, or the fixed-column write would zero it",
    );
    assert.equal(updated.title, "specified", "the title survived a call that never named it");
    assert.equal(updated.color, "ff0000");
    assert.equal(stored().find((entry) => entry.id === 45)?.description, "groomed and ready");
  });

  it("R1/R3: a rename writes the new title and keeps the stored colour", async () => {
    const { client, resolver } = stack();

    const updated = await updateLabel(client, resolver, 45, { title: "ready" });

    assert.deepEqual(updated, { id: 45, title: "ready", color: "0ea5e9" });
  });

  it("R2: an empty colour clears the label's colour rather than being ignored", async () => {
    const { client, resolver, stored } = stack();

    const updated = await updateLabel(client, resolver, 45, { color: "" });

    assert.equal("color" in updated, false);
    assert.equal(stored().find((entry) => entry.id === 45)?.hex_color, "");
  });

  it("R3: refuses a call naming neither a title nor a colour, before any request", async () => {
    const { client, resolver, calls } = stack();

    await assert.rejects(() => updateLabel(client, resolver, 45, {}), /title/i);
    assert.equal(calls.length, 0, "nothing was read and nothing was written");
  });

  it("R4: renaming a label to the title it already has is not a duplicate", async () => {
    const { client, resolver } = stack();

    const updated = await updateLabel(client, resolver, 5, { title: "feature", color: "111111" });

    assert.deepEqual(updated, { id: 5, title: "feature", color: "111111" });
  });

  it("R4: refuses a rename onto another label's title, naming its id and writing nothing", async () => {
    const { client, resolver, calls, stored } = stack();

    await assert.rejects(() => updateLabel(client, resolver, 45, { title: "feature" }), /id 5/);

    assert.ok(!calls.some((call) => call.method === "POST"), "no write was issued");
    assert.equal(stored().find((entry) => entry.id === 45)?.title, "specified");
  });

  it("R2: refuses an unparseable colour before anything is written", async () => {
    const { client, resolver, calls } = stack();

    await assert.rejects(() => updateLabel(client, resolver, 45, { color: "red" }), /six hex/);
    assert.ok(!calls.some((call) => call.method === "POST"), "no write was issued");
  });

  it("R6: refuses a label that does not exist, writing nothing", async () => {
    const { client, resolver, calls } = stack();

    await assert.rejects(() => updateLabel(client, resolver, "nope", { title: "x" }), /No label/);
    assert.ok(!calls.some((call) => call.method === "POST"));
  });
});

describe("delete_label data path", () => {
  const CARRYING: RawTask[] = [
    task(600, 1, [SPECIFIED]),
    task(601, 2, [SPECIFIED, FEATURE]),
    task(602, 3, [SPECIFIED]),
  ];

  it("R5: refuses while tasks carry the label, naming how many, and deletes nothing", async () => {
    const { client, resolver, calls, stored } = stack(LABELS, CARRYING);

    await assert.rejects(() => deleteLabel(client, resolver, "specified"), /3 task/);

    assert.ok(!calls.some((call) => call.method === "DELETE"), "nothing was deleted");
    assert.ok(
      stored().some((entry) => entry.id === 45),
      "the label is still there",
    );
  });

  it("R5: counts through the label filter rather than reading every task", async () => {
    const { client, resolver, calls } = stack(LABELS, CARRYING);

    await assert.rejects(() => deleteLabel(client, resolver, "specified"), /3 task/);

    const listing = calls.find((call) => call.path === "/api/v1/tasks");
    assert.ok(listing, "counted through GET /tasks");
  });

  it("R5: force deletes it and reports what it was detached from", async () => {
    const { client, resolver, calls, stored } = stack(LABELS, CARRYING);

    const answer = await deleteLabel(client, resolver, "specified", true);

    assert.deepEqual(answer, { deleted: true, id: 45, title: "specified", detachedFrom: 3 });
    const deletes = calls.filter((call) => call.method === "DELETE");
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0]?.path, "/api/v1/labels/45");
    assert.equal(
      stored().some((entry) => entry.id === 45),
      false,
    );
  });

  it("R5: deletes a label no task carries without needing force, reporting 0", async () => {
    const { client, resolver, calls, stored } = stack(LABELS, [task(600, 1, [FEATURE])]);

    const answer = await deleteLabel(client, resolver, 45);

    assert.deepEqual(answer, { deleted: true, id: 45, title: "specified", detachedFrom: 0 });
    assert.ok(calls.some((call) => call.method === "DELETE"));
    assert.equal(
      stored().some((entry) => entry.id === 45),
      false,
    );
  });

  it("R6: refuses an unknown label before counting anything", async () => {
    const { client, resolver, calls } = stack(LABELS, CARRYING);

    await assert.rejects(() => deleteLabel(client, resolver, 99, true), /No label has id 99/);
    assert.ok(!calls.some((call) => call.path === "/api/v1/tasks"), "no listing was paid for");
    assert.ok(!calls.some((call) => call.method === "DELETE"));
  });
});

/**
 * The composition itself, pinned case by case.
 *
 * Each of these fails against one specific mutation of a tool body — the four that were possible
 * while those bodies lived in the registration files, where every one of them left the suite
 * green:
 *
 * 1. `applyLabelCreate` stops calling `checkLabelTitleAvailable`.
 * 2. `applyLabelDelete` stops calling `checkLabelDeletable`.
 * 3. `applyLabelUpdate` stops passing `title` to `resolveLabel`.
 * 4. `applyLabelDelete` reports a hardcoded `detachedFrom: 0`.
 *
 * The overlap with the data-path cases above is deliberate: those describe what a caller sees,
 * these say which line of the composition holds them up.
 */
describe("tool bodies: the composition a registration file cannot be trusted with", () => {
  it("R4: create checks the title against the instance before it writes anything", async () => {
    // Mutation 1: drop the refusal and the create goes through, leaving two labels that share a
    // title — and every other tool then unable to name either of them.
    const { client, resolver, calls, stored } = stack();

    await assert.rejects(() => createLabel(client, resolver, "FEATURE"), /id 5/);

    assert.ok(!calls.some((call) => call.method === "PUT"), "the write never happened");
    assert.equal(stored().length, LABELS.length, "and no label was added");
  });

  it("R5: delete consults the guard, so a label in use survives a call without force", async () => {
    // Mutation 2: drop the guard and this deletes a label off three tasks, silently.
    const { client, resolver, calls, stored } = stack(LABELS, [task(600, 1, [SPECIFIED])]);

    await assert.rejects(() => deleteLabel(client, resolver, 45), /1 task\b/);

    assert.ok(!calls.some((call) => call.method === "DELETE"));
    assert.ok(stored().some((entry) => entry.id === 45));
  });

  it("R4: update hands the new title to the resolver, which is the whole rename check", async () => {
    // Mutation 3: resolve without the title and the rename lands on a title label 5 holds. The
    // resolve itself still succeeds either way, so only the write's absence detects it.
    const { client, resolver, calls, stored } = stack();

    await assert.rejects(() => updateLabel(client, resolver, 45, { title: "Feature " }), /id 5/);

    assert.ok(!calls.some((call) => call.method === "POST"), "no write was issued");
    assert.equal(stored().find((entry) => entry.id === 45)?.title, "specified");
  });

  it("R5: the delete answer carries the count it guarded on, not a constant", async () => {
    // Mutation 4: a hardcoded `detachedFrom: 0` reads as "nothing was affected" for a call that
    // just took the label off two tasks.
    const { client, resolver } = stack(LABELS, [
      task(600, 1, [SPECIFIED]),
      task(601, 2, [SPECIFIED]),
    ]);

    const answer = await deleteLabel(client, resolver, 45, true);

    assert.equal(answer.detachedFrom, 2, "the number the guard counted is the number reported");
  });
});

/**
 * The two refusals that need no server at all, exercised directly rather than through a flow —
 * the pieces of `src/tools/label-fields.ts` that decide without asking anything.
 */
describe("label-fields refusals", () => {
  it("R3: an update naming no field is refused, and one naming either is not", () => {
    assert.throws(() => checkLabelPatch({}), /title/i);
    assert.doesNotThrow(() => checkLabelPatch({ title: "x" }));
    assert.doesNotThrow(() => checkLabelPatch({ color: "" }), "clearing a colour is a change");
  });

  it("R5: the delete guard turns on the count and on force, and says how to proceed", () => {
    assert.doesNotThrow(() => checkLabelDeletable(SPECIFIED, 0, false), "nothing carries it");
    assert.doesNotThrow(() => checkLabelDeletable(SPECIFIED, 142, true), "force was passed");

    assert.throws(
      () => checkLabelDeletable(SPECIFIED, 142, false),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /142/, "names how many tasks carry it");
        assert.match(error.message, /force/, "and how to proceed");
        assert.match(error.message, /specified/, "and which label it is talking about");
        return true;
      },
    );
  });
});
