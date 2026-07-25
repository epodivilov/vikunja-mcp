---
"@epodivilov/vikunja-mcp": minor
---

Add `vikunja_label_task` (add and/or remove labels on an existing task, leaving every label the call does not name in place) and `vikunja_set_task_labels` (replace a task's whole label set; an empty list clears it). Both land the change in one atomic write through Vikunja's bulk label endpoint, so adds and removes take effect together and a repeated call changes nothing. Labels still cannot be changed through `vikunja_update_task` — its refusal now names the tools that can.
