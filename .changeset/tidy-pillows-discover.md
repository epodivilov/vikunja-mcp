---
"@epodivilov/vikunja-mcp": patch
---

Discover the page size from the Vikunja instance instead of guessing: read `max_items_per_page` from `GET /info` at startup and send it as `per_page` on every paginated request, falling back to the default of 1000 (with a single stderr diagnostic) when `/info` cannot be read or reports no usable value.
