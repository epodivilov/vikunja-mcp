---
"@epodivilov/vikunja-mcp": patch
---

Unify relative import specifiers in `src/` on the `.ts` file each one names (tsc still emits `.js` into `dist/` via `rewriteRelativeImportExtensions`), so `node --test` can load a tool module that value-imports a sibling. On the back of that, `vikunja_update_task` and `vikunja_bulk_update_tasks` now state `destructiveHint: true` explicitly instead of relying on the MCP default — the served `tools/list` gains the key, but the resolved value is unchanged (the default is already `true`).
