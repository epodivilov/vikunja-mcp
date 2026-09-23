import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { VikunjaClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { toLeanAttachment } from "../src/projection.ts";
import { attachmentResult } from "../src/tools/result.ts";
import type { LeanAttachment, RawAttachment } from "../src/types.ts";

const config: Config = { baseUrl: "http://vikunja.test/api/v1", token: "secret-token" };
const attachment = (id: number, taskId = 7): RawAttachment => ({
  id,
  task_id: taskId,
  created: "2026-01-02T03:04:05Z",
  created_by: { username: "alice" },
  file: { id: id + 100, name: `file-${id}.txt`, mime: "text/plain", size: 4, created: "" },
});
const metadata: LeanAttachment = {
  id: 11,
  taskId: 7,
  filename: "asset.bin",
  mimeType: "application/octet-stream",
  size: 2,
  created: "2026-01-02T03:04:05Z",
};

function response(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("attachment projection", () => {
  it("R1: projects the nested Vikunja attachment into lean metadata", () => {
    assert.deepEqual(toLeanAttachment(attachment(11)), {
      id: 11,
      taskId: 7,
      filename: "file-11.txt",
      mimeType: "text/plain",
      size: 4,
      created: "2026-01-02T03:04:05Z",
      uploader: "alice",
    });
  });
});

describe("attachment client", () => {
  it("R1: exhausts attachment pagination", async () => {
    const calls: string[] = [];
    const client = new VikunjaClient(config, {
      pageSize: 2,
      fetch: async (input, _init) => {
        calls.push(String(input));
        const page = new URL(String(input)).searchParams.get("page");
        return response([attachment(Number(page))], { "x-pagination-total-pages": "2" });
      },
    });

    assert.equal((await client.listAttachments(7)).length, 2);
    assert.deepEqual(
      calls.map((url) => new URL(url).searchParams.get("page")),
      ["1", "2"],
    );
  });

  it("R2: validates every local path before issuing the multipart request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vikunja-attachments-"));
    const valid = join(directory, "hello.txt");
    await writeFile(valid, "hello");
    let requests = 0;
    const client = new VikunjaClient(config, {
      fetch: async (_input, _init) => {
        requests += 1;
        return response({ success: [attachment(21)], errors: [] });
      },
    });

    await assert.rejects(
      () => client.uploadAttachments(7, [valid, join(directory, "missing.txt")]),
      /missing\.txt.*(missing|read|regular)/i,
    );
    assert.equal(requests, 0);
  });

  it("R2: uploads valid files as files multipart fields and preserves partial API failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vikunja-attachments-"));
    const first = join(directory, "one.txt");
    const second = join(directory, "two.bin");
    await writeFile(first, "one");
    await writeFile(second, Buffer.from([1, 2]));
    let request: RequestInit | undefined;
    const client = new VikunjaClient(config, {
      fetch: async (_input, init) => {
        request = init;
        return response({
          success: [attachment(22)],
          errors: [{ code: 4005, message: "The attachment is too large." }],
        });
      },
    });

    const result = await client.uploadAttachments(7, [first, second]);
    assert.deepEqual(result.errors, [{ code: 4005, message: "The attachment is too large." }]);
    assert.equal(result.success.length, 1);
    assert.ok(request?.body instanceof FormData);
    const files = request.body.getAll("files") as File[];
    assert.deepEqual(
      files.map((file) => file.name),
      ["one.txt", "two.bin"],
    );
  });

  it("R2: normalises Vikunja's null slices in all-success and all-failure results", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vikunja-attachments-"));
    const file = join(directory, "one.txt");
    await writeFile(file, "one");
    const responses = [
      { success: [attachment(23)], errors: null },
      { success: null, errors: [{ message: "upload refused" }] },
    ];
    const client = new VikunjaClient(config, {
      fetch: async () => response(responses.shift()),
    });

    assert.deepEqual(await client.uploadAttachments(7, [file]), {
      success: [attachment(23)],
      errors: [],
    });
    assert.deepEqual(await client.uploadAttachments(7, [file]), {
      success: [],
      errors: [{ message: "upload refused" }],
    });
  });

  it("R7: refuses a malformed upload result instead of reporting an empty success", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vikunja-attachments-"));
    const file = join(directory, "one.txt");
    await writeFile(file, "one");
    const client = new VikunjaClient(config, {
      fetch: async () => response({ message: "legacy or malformed upload response" }),
    });

    await assert.rejects(
      () => client.uploadAttachments(7, [file]),
      /invalid result without attachment metadata/i,
    );
  });

  it("R2: rejects relative paths, directories, and files over 5 MiB before a request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vikunja-attachments-"));
    const oversized = join(directory, "oversized.bin");
    await writeFile(oversized, new Uint8Array(5 * 1024 * 1024 + 1));
    let requests = 0;
    const client = new VikunjaClient(config, {
      fetch: async () => {
        requests += 1;
        return response({ success: [], errors: [] });
      },
    });

    await assert.rejects(() => client.uploadAttachments(7, ["relative.txt"]), /absolute/i);
    await assert.rejects(() => client.uploadAttachments(7, [directory]), /regular file/i);
    await assert.rejects(() => client.uploadAttachments(7, [oversized]), /5 MiB/i);
    assert.equal(requests, 0);
  });

  it("R3/R4: downloads a bounded attachment and passes preview_size", async () => {
    let requestedUrl = "";
    const client = new VikunjaClient(config, {
      fetch: async (input) => {
        requestedUrl = String(input);
        return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });
      },
    });

    const result = await client.getAttachment(7, 11, "md");
    assert.equal(new TextDecoder().decode(result.bytes), "hello");
    assert.equal(new URL(requestedUrl).searchParams.get("preview_size"), "md");
  });

  it("R7: refuses an oversized streamed response without returning its bytes", async () => {
    const client = new VikunjaClient(config, {
      fetch: async () => new Response(new Uint8Array(5 * 1024 * 1024 + 1), { status: 200 }),
    });

    await assert.rejects(() => client.getAttachment(7, 11), /5 MiB|too large|size/i);
  });

  it("R6: deletes an attachment through its dedicated endpoint", async () => {
    let method = "";
    let url = "";
    const client = new VikunjaClient(config, {
      fetch: async (input, init) => {
        url = String(input);
        method = init?.method ?? "";
        return new Response("", { status: 200 });
      },
    });

    await client.deleteAttachment(7, 11);
    assert.equal(method, "DELETE");
    assert.match(url, /\/tasks\/7\/attachments\/11$/);
  });
});

describe("attachment MCP content", () => {
  it("R3: returns image/audio blocks and embedded text/blob resources", () => {
    assert.equal(
      attachmentResult({ ...metadata, mimeType: "image/png" }, new Uint8Array([1]), "image/png")
        .content[1]?.type,
      "image",
    );
    assert.equal(
      attachmentResult({ ...metadata, mimeType: "audio/mpeg" }, new Uint8Array([1]), "audio/mpeg")
        .content[1]?.type,
      "audio",
    );
    const text = attachmentResult(
      { ...metadata, mimeType: "text/plain" },
      new TextEncoder().encode("hello"),
      "text/plain",
    );
    assert.deepEqual(text.content[1], {
      type: "resource",
      resource: { uri: "attachment://11", mimeType: "text/plain", text: "hello" },
    });
    const blob = attachmentResult(metadata, new Uint8Array([1, 2]), metadata.mimeType);
    assert.deepEqual(blob.content[1], {
      type: "resource",
      resource: { uri: "attachment://11", mimeType: "application/octet-stream", blob: "AQI=" },
    });

    const json = attachmentResult(
      { ...metadata, mimeType: "application/json" },
      new TextEncoder().encode('{"ok":true}'),
      "application/json",
    );
    assert.deepEqual(json.content[1], {
      type: "resource",
      resource: {
        uri: "attachment://11",
        mimeType: "application/json",
        text: '{"ok":true}',
      },
    });
  });

  it("R7: refuses malformed UTF-8 without returning bytes", () => {
    assert.throws(
      () =>
        attachmentResult(
          { ...metadata, mimeType: "text/plain" },
          new Uint8Array([0xc3, 0x28]),
          "text/plain",
        ),
      /not valid UTF-8|no attachment bytes/i,
    );
  });
});
