/**
 * The one wire format every tool answers in.
 *
 * MCP carries tool output as text, so the lean DTOs are serialised here and nowhere else —
 * a tool that hand-rolled its own envelope would be free to drift into prose, or into
 * stringifying a raw API object.
 *
 * Deliberately compact JSON: indentation is whitespace the model pays tokens for, and a
 * listing of a few hundred rows is exactly where this server is meant to be cheaper than the
 * alternatives it replaces.
 */
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { LeanAttachment } from "../types.ts";

export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Builds protocol-native content while keeping metadata separate from the returned bytes. */
export function attachmentResult(
  attachment: LeanAttachment,
  bytes: Uint8Array,
  contentType: string,
): CallToolResult {
  const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() || attachment.mimeType;
  const metadata = JSON.stringify(attachment);
  const base64 = Buffer.from(bytes).toString("base64");
  const content: ContentBlock[] = [{ type: "text", text: metadata }];

  if (mimeType.startsWith("image/")) {
    content.push({ type: "image", data: base64, mimeType });
  } else if (mimeType.startsWith("audio/")) {
    content.push({ type: "audio", data: base64, mimeType });
  } else if (isTextMimeType(mimeType)) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(
        `Attachment ${attachment.id} is labelled ${mimeType} but is not valid UTF-8 text; no attachment bytes were returned.`,
      );
    }
    content.push({
      type: "resource",
      resource: { uri: `attachment://${attachment.id}`, mimeType, text },
    });
  } else {
    content.push({
      type: "resource",
      resource: { uri: `attachment://${attachment.id}`, mimeType, blob: base64 },
    });
  }

  return { content };
}

function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType.endsWith("+json") ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+xml") ||
    mimeType === "application/javascript"
  );
}
