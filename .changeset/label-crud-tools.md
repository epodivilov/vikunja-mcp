---
"@epodivilov/vikunja-mcp": minor
---

Close the label CRUD: `vikunja_create_label` (create one, refusing an empty title and a title another label already holds — Vikunja accepts both, and a duplicate makes *both* labels unaddressable by title everywhere else), `vikunja_update_label` (rename and/or recolour, merging onto the whole stored record so the fixed-column write cannot blank the fields the call did not name) and `vikunja_delete_label` (its own tool, `destructiveHint`, refusing while tasks carry the label unless `force` is passed and reporting how many were detached). `LeanLabel` grows an optional `color`, so `vikunja_list_labels` and the two write answers describe a label the same way.
