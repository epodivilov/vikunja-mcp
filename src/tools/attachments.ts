import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VikunjaClient } from "../client.ts";
import { toLeanAttachment } from "../projection.ts";
import type { Resolver } from "../resolver.ts";
import type { RawAttachment } from "../types.ts";
import { attachmentResult, jsonResult } from "./result.ts";
import { resolveTaskTarget, taskTargetShape } from "./task-target.ts";

const attachmentIdShape = {
  ...taskTargetShape,
  attachmentId: z
    .number()
    .int()
    .positive()
    .describe("Global attachment id from vikunja_list_attachments."),
};

const previewSize = z
  .enum(["sm", "md", "lg", "xl"])
  .optional()
  .describe("Optional image preview size: sm (100px), md (200px), lg (400px), or xl (800px).");

export function registerListAttachmentsTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_list_attachments",
    {
      title: "List task attachments",
      description:
        "Lists every attachment on a task, exhausting pagination, as lean metadata with id, taskId, filename, MIME type, byte size, creation timestamp, and uploader when available.",
      inputSchema: z.strictObject({ ...taskTargetShape }),
      annotations: { readOnlyHint: true },
    },
    async ({ task, id }) => {
      const target = await resolveTaskTarget(client, resolver, { task, id });
      return jsonResult((await client.listAttachments(target.id)).map(toLeanAttachment));
    },
  );
}

export function registerUploadAttachmentsTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_upload_attachments",
    {
      title: "Upload task attachments",
      description:
        "Uploads one or more absolute local regular files to a task. Every path is validated before any upload; each file must be readable and at most 5 MiB. Returns created metadata and per-file API failures.",
      inputSchema: z.strictObject({
        ...taskTargetShape,
        paths: z.array(z.string().min(1)).min(1).describe("Absolute local file paths to upload."),
      }),
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ task, id, paths }) => {
      const target = await resolveTaskTarget(client, resolver, { task, id });
      const result = await client.uploadAttachments(target.id, paths);
      return jsonResult({
        attachments: result.success.map(toLeanAttachment),
        failures: result.errors,
      });
    },
  );
}

export function registerGetAttachmentTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_get_attachment",
    {
      title: "Get task attachment",
      description:
        "Returns an attachment that belongs to the named task. Images and audio are native MCP content, UTF-8 text is an embedded text resource, and other MIME types are an embedded base64 resource; returned bytes are limited to 5 MiB.",
      inputSchema: z.strictObject({ ...attachmentIdShape, previewSize }),
      annotations: { readOnlyHint: true },
    },
    async ({ task, id, attachmentId, previewSize: requestedPreview }) => {
      const target = await resolveTaskTarget(client, resolver, { task, id });
      const listed = await attachmentOnTask(client, target.id, attachmentId);
      const downloaded = await client.getAttachment(target.id, attachmentId, requestedPreview);
      return attachmentResult(toLeanAttachment(listed), downloaded.bytes, downloaded.contentType);
    },
  );
}

export function registerDeleteAttachmentTool(
  server: McpServer,
  client: VikunjaClient,
  resolver: Resolver,
): void {
  server.registerTool(
    "vikunja_delete_attachment",
    {
      title: "Delete task attachment",
      description:
        "Permanently deletes an attachment belonging to the named task and returns its metadata. This is destructive; the host remains responsible for explicit user confirmation.",
      inputSchema: z.strictObject({ ...attachmentIdShape }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ task, id, attachmentId }) => {
      const target = await resolveTaskTarget(client, resolver, { task, id });
      const listed = await attachmentOnTask(client, target.id, attachmentId);
      await client.deleteAttachment(target.id, attachmentId);
      return jsonResult({ deleted: true, attachment: toLeanAttachment(listed) });
    },
  );
}

async function attachmentOnTask(
  client: VikunjaClient,
  taskId: number,
  attachmentId: number,
): Promise<RawAttachment> {
  const attachments = await client.listAttachments(taskId);
  const found = attachments.find((attachment) => attachment.id === attachmentId);
  if (found === undefined) {
    throw new Error(
      `Attachment ${attachmentId} does not belong to task ${taskId}; refusing the attachment operation without calling its content or delete endpoint.`,
    );
  }
  return found;
}
