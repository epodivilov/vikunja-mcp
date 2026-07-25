---
"@epodivilov/vikunja-mcp": minor
---

Add task assignment: `vikunja_assign_task` and `vikunja_unassign_task` (users named by username, with the global id as an escape hatch), `vikunja_list_members` (the users a project can assign to, as `{ id, username, name? }` and never an email), and an `assignees` argument on `vikunja_create_task`. Every lean task now carries `assignees` — the usernames of the people it is assigned to — omitted when it has none.
