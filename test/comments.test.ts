/**
 * The comment CRUD data paths, composed from the real `Resolver`, `VikunjaClient` and projection
 * — the exact layers the four comment tools wire together — over a single routing `fetch`.
 *
 * Honest about what is and is not covered: `src/tools/*` cannot be imported under `node --test`
 * (they carry `.js` value specifiers the type-stripping loader will not resolve to `.ts`), so the
 * four registration files themselves are unproved here. What IS proved directly is everything
 * they delegate to — `resolveCommentTarget`, which is imported from `src/tools/task-target.ts`
 * for real (that module's only runtime import is zod, so it loads), the client's request shapes
 * and the projection. The `listComments`/`getComment`/`updateComment` helpers below are the tool
 * bodies transcribed: they show the layers fit together, not that a tool file calls them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VikunjaClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { markdownToHtml, toLeanComment, toLeanTask } from "../src/projection.ts";
import { Resolver } from "../src/resolver.ts";
import { resolveCommentTarget, resolveTaskTarget } from "../src/tools/task-target.ts";
import type { LeanComment, RawComment, RawProject, RawTask } from "../src/types.ts";

const config: Config = { baseUrl: "http://vikunja.test/api/v1", token: "t0ken" };

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

const PROJECTS: RawProject[] = [
  { id: 11, title: "vikunja-mcp", identifier: "VMCP", description: "", is_archived: false },
];

const TASK: RawTask = {
  id: 600,
  project_id: 11,
  index: 22,
  identifier: "VMCP-22",
  title: "Read, edit, and delete task comments",
  description: "",
  done: false,
  priority: 0,
  due_date: "0001-01-01T00:00:00Z",
  labels: null,
  assignees: null,
};

/** As the server sends them: the author expanded to a full user object, plus fields we drop. */
type ServerComment = RawComment & { updated: string; reactions: Record<string, unknown> };

const COMMENTS: ServerComment[] = [
  {
    id: 91,
    comment: "<p>Groomed against a third-party MCP</p>",
    author: {
      id: 3,
      username: "evgenii",
      name: "",
      email: "ev@example.com",
    } as RawComment["author"],
    created: "2026-07-24T18:21:09Z",
    updated: "2026-07-24T18:21:09Z",
    reactions: {},
  },
  {
    id: 92,
    comment: "Legacy **markdown** body",
    author: null,
    created: "2026-07-24T19:02:44Z",
    updated: "2026-07-24T19:02:44Z",
    reactions: {},
  },
];

/** One routing fetch answering every endpoint the comment flows touch, recording each request. */
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
      const filter = url.searchParams.get("filter") ?? "";
      return listing(filter === "project_id = 11 && index = 22" ? [TASK] : []);
    }

    if (method === "GET" && path === "/api/v1/tasks/600") {
      return json(TASK);
    }

    if (method === "GET" && path === "/api/v1/tasks/600/comments") {
      return listing(COMMENTS);
    }

    const one = /^\/api\/v1\/tasks\/600\/comments\/(\d+)$/.exec(path);
    if (one) {
      const wanted = Number(one[1]);
      const found = COMMENTS.find((comment) => comment.id === wanted);
      if (found === undefined) {
        return new Response(
          JSON.stringify({ code: 4015, message: "This comment does not exist" }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (method === "GET") {
        return json(found);
      }
      if (method === "POST") {
        const patch = body as { comment?: string };
        return json({ ...found, comment: patch.comment });
      }
      if (method === "DELETE") {
        return new Response("", { status: 200 });
      }
    }

    throw new Error(`unrouted ${method} ${path}`);
  }) as typeof globalThis.fetch;

  const client = new VikunjaClient(config, { fetch });
  return { client, resolver: new Resolver(client), calls };
}

/** The list_comments body: resolve the task, read every comment, project each one. */
async function listComments(
  client: VikunjaClient,
  resolver: Resolver,
  task: string,
): Promise<LeanComment[]> {
  const target = await resolveTaskTarget(client, resolver, { task });
  return (await client.listComments(target.id)).map(toLeanComment);
}

/** The get_comment body: resolve the task and comment id, read that one, project it. */
async function getComment(
  client: VikunjaClient,
  resolver: Resolver,
  task: string,
  commentId: number,
): Promise<LeanComment> {
  const target = await resolveCommentTarget(client, resolver, { task, commentId });
  return toLeanComment(await client.getComment(target.task.id, target.commentId));
}

/** The update_comment body: markdown in, HTML on the wire, the task's ref back out. */
async function updateComment(
  client: VikunjaClient,
  resolver: Resolver,
  task: string,
  commentId: number,
  comment: string,
): Promise<{ ref: string; commentId: number }> {
  const target = await resolveCommentTarget(client, resolver, { task, commentId });
  await client.updateComment(target.task.id, target.commentId, markdownToHtml(comment));
  return { ref: toLeanTask(target.task).ref, commentId: target.commentId };
}

describe("list_comments data path", () => {
  it("R1: a task key -> its comments as lean rows, with no user object in sight", async () => {
    const { client, resolver, calls } = stack();

    const comments = await listComments(client, resolver, "VMCP-22");

    assert.deepEqual(comments, [
      {
        id: 91,
        comment: "Groomed against a third-party MCP",
        author: "evgenii",
        created: "2026-07-24T18:21:09Z",
      },
      { id: 92, comment: "Legacy **markdown** body", created: "2026-07-24T19:02:44Z" },
    ]);
    assert.equal(JSON.stringify(comments).includes("ev@example.com"), false);
    assert.ok(
      calls.some((call) => call.path === "/api/v1/tasks/600/comments" && call.method === "GET"),
      "read the task's comment collection",
    );
  });
});

describe("get_comment data path", () => {
  it("R2: a task key plus a comment id -> that one comment, projected", async () => {
    const { client, resolver, calls } = stack();

    const comment = await getComment(client, resolver, "VMCP-22", 91);

    assert.deepEqual(comment, {
      id: 91,
      comment: "Groomed against a third-party MCP",
      author: "evgenii",
      created: "2026-07-24T18:21:09Z",
    });
    assert.ok(
      calls.some((call) => call.path === "/api/v1/tasks/600/comments/91" && call.method === "GET"),
      "addressed by task and comment id, as the endpoint requires",
    );
  });
});

describe("update_comment data path", () => {
  it("R3: the markdown body reaches the client as HTML, and the task ref comes back", async () => {
    const { client, resolver, calls } = stack();

    const answer = await updateComment(client, resolver, "VMCP-22", 91, "Now **edited**");

    const post = calls.find((call) => call.method === "POST");
    assert.ok(post, "issued the update POST");
    assert.equal(post.path, "/api/v1/tasks/600/comments/91");
    assert.deepEqual(post.body, { comment: "<p>Now <strong>edited</strong></p>" });
    assert.deepEqual(answer, { ref: "VMCP-22", commentId: 91 });
  });

  it("R3: raw HTML in the markdown body is escaped, never passed through", async () => {
    // Vikunja stores comment bodies verbatim and sanitizes nothing, and the markdown here was
    // written by a model that just read text from tasks it does not own.
    const { client, resolver, calls } = stack();

    await updateComment(client, resolver, "VMCP-22", 91, "<script>alert(1)</script>");

    const post = calls.find((call) => call.method === "POST");
    assert.ok(post);
    const sent = (post.body as { comment: string }).comment;
    assert.equal(sent.includes("<script>"), false);
    assert.match(sent, /&lt;script&gt;/);
  });
});

describe("delete_comment data path", () => {
  it("R4: a task key plus a comment id -> a DELETE on the per-comment path", async () => {
    const { client, resolver, calls } = stack();

    const target = await resolveCommentTarget(client, resolver, { task: "VMCP-22", commentId: 91 });
    await client.deleteComment(target.task.id, target.commentId);

    const deleted = calls.find((call) => call.method === "DELETE");
    assert.ok(deleted, "issued the delete");
    assert.equal(deleted.path, "/api/v1/tasks/600/comments/91");
  });
});

describe("comment addressing contract", () => {
  it("R6: refuses both a key and an id, before any request", async () => {
    const { client, resolver, calls } = stack();

    await assert.rejects(
      resolveCommentTarget(client, resolver, { task: "VMCP-22", id: 600, commentId: 91 }),
      /not both/,
    );
    assert.equal(calls.length, 0, "nothing was requested");
  });

  it("R6: refuses neither a key nor an id, before any request", async () => {
    const { client, resolver, calls } = stack();

    await assert.rejects(resolveCommentTarget(client, resolver, { commentId: 91 }), /Which task/);
    assert.equal(calls.length, 0, "nothing was requested");
  });

  it("R6: refuses a missing comment id, before any request", async () => {
    const { client, resolver, calls } = stack();

    // Checked on the caller's input, not on anything read back: the task is never fetched.
    await assert.rejects(
      resolveCommentTarget(client, resolver, { task: "VMCP-22" }),
      /Which comment/,
    );
    await assert.rejects(resolveCommentTarget(client, resolver, { id: 600 }), /Which comment/);
    assert.equal(calls.length, 0, "nothing was requested");
  });

  it("R6: refuses a comment id that is not a positive integer, before any request", async () => {
    const { client, resolver, calls } = stack();
    const lying = (value: unknown) =>
      resolveCommentTarget(client, resolver, { task: "VMCP-22", commentId: value as number });

    await assert.rejects(lying(0), /positive integer/);
    await assert.rejects(lying(-1), /positive integer/);
    await assert.rejects(lying(1.5), /positive integer/);
    await assert.rejects(lying("91"), /positive integer/);
    assert.equal(calls.length, 0, "nothing was requested");
  });

  it("R6: resolves the task by key and hands the comment id through", async () => {
    const { client, resolver } = stack();

    const target = await resolveCommentTarget(client, resolver, { task: "VMCP-22", commentId: 91 });

    assert.equal(target.task.id, 600);
    assert.equal(target.commentId, 91);
  });

  it("R6: resolves the task by the id escape hatch too", async () => {
    const { client, resolver } = stack();

    const target = await resolveCommentTarget(client, resolver, { id: 600, commentId: 92 });

    assert.equal(target.task.identifier, "VMCP-22");
    assert.equal(target.commentId, 92);
  });
});
