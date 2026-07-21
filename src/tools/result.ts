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
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
