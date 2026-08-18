---
"@epodivilov/vikunja-mcp": minor
---

Add `vikunja_update_tasks`: update many tasks in one call, each with its own patch, returning `{ updated, failed }` — a heterogeneous read-modify-write loop that resolves every target first (all-or-nothing, refusing duplicate targets), then applies each patch collecting per-item outcomes. Unlike `vikunja_bulk_update_tasks` it preserves assignees, reminders and favourites.
