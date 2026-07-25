---
"@epodivilov/vikunja-mcp": minor
---

Add the read and edit half of the comment surface: `vikunja_list_comments` and `vikunja_get_comment` (read a task's discussion, bodies converted to markdown and the author reduced to a username), `vikunja_update_comment` (replace a body, markdown in and HTML stored) and `vikunja_delete_comment` (its own tool, so it can be denied on its own). `vikunja_comment_task` is unchanged.
