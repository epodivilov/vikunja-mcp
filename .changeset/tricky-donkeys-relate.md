---
"@epodivilov/vikunja-mcp": minor
---

Add `vikunja_relate_tasks` and `vikunja_unrelate_tasks` (relate two tasks by key under any of Vikunja's eleven relation kinds — blocking, subtask, precedes, duplicates and the rest — with the inverse relation left to the server), and surface a task's related tasks on `vikunja_get_task` as lean `{ kind, ref, title, done }` refs whose keys are rebuilt per the related task's own project.
