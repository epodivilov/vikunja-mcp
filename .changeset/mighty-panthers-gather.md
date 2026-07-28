---
"@epodivilov/vikunja-mcp": minor
---

Add `vikunja_bulk_update_tasks`: set the same `done`, `priority` and/or `due` across many tasks — named by key, with global ids as the escape hatch — in a single transactional `POST /tasks/bulk`, the one genuine partial-update path in the Vikunja API. Every name is resolved before anything is written, the write is all-or-nothing, and the answer is the tasks read back from the server. Tasks carrying assignees or reminders, or favourited by the calling user, are refused by name: that endpoint destroys all three whatever fields it is told to write, so `vikunja_update_task` remains the way to change those.
