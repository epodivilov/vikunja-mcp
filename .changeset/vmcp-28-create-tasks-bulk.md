---
"@epodivilov/vikunja-mcp": minor
---

Add `vikunja_create_tasks`: create many tasks in one project in a single call, returning `{ created, failed }` — resolves every project/label/assignee name first (all-or-nothing), then creates in order collecting per-item outcomes.
