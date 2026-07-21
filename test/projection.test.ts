/**
 * Every case here was observed on a live Vikunja 0.24 instance or produced by
 * its TipTap editor. Where a literal looks odd (a `<label>` wrapping the
 * checkbox, a `<p>` inside a table cell) that is the server's actual shape, not
 * a simplification.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  htmlToMarkdown,
  markdownToHtml,
  nullableDate,
  toLeanLabel,
  toLeanProject,
  toLeanTask,
  toLeanTaskDetail,
  toTaskWrite,
} from "../src/projection.ts";
import type { RawProject, RawTask } from "../src/types.ts";

/** A task as the API returns it with every optional value unset. */
const bareTask: RawTask = {
  id: 42,
  project_id: 7,
  index: 41,
  identifier: "INFRA-41",
  title: "Rotate the certs",
  description: "",
  done: false,
  priority: 0,
  due_date: "0001-01-01T00:00:00Z",
  labels: null,
};

/** A project as the API returns it. `description` and `is_archived` never reach the model. */
const bareProject: RawProject = {
  id: 5,
  title: "Infrastructure",
  identifier: "INFRA",
  description: "",
  is_archived: false,
};

/** TipTap wraps the checkbox in a `<label>`, so it is not the `<li>`'s first child. */
const TIPTAP_TASK_LIST =
  '<ul data-type="taskList">' +
  '<li data-checked="true" data-type="taskItem">' +
  '<label><input type="checkbox" checked><span></span></label><div><p>done thing</p></div></li>' +
  '<li data-checked="false" data-type="taskItem">' +
  '<label><input type="checkbox"><span></span></label><div><p>open thing</p></div></li>' +
  "</ul>";

/** TipTap puts a `<p>` inside every cell, which turns cell content block-level. */
const TIPTAP_TABLE =
  "<table><tbody>" +
  "<tr><th><p>Env</p></th><th><p>URL</p></th></tr>" +
  "<tr><td><p>prod</p></td><td><p>https://a.example</p></td></tr>" +
  "</tbody></table>";

describe("nullableDate", () => {
  it("drops the zero timestamp", () => {
    assert.equal(nullableDate("0001-01-01T00:00:00Z"), undefined);
  });

  it("drops an empty string", () => {
    assert.equal(nullableDate(""), undefined);
  });

  it("keeps a real timestamp", () => {
    assert.equal(nullableDate("2026-07-21T13:00:00Z"), "2026-07-21T13:00:00Z");
  });
});

describe("toLeanTask", () => {
  it("reads the key from identifier rather than composing it", () => {
    assert.equal(toLeanTask(bareTask).ref, "INFRA-41");
  });

  it("keeps the server fallback key for a project with no identifier", () => {
    assert.equal(toLeanTask({ ...bareTask, identifier: "#3" }).ref, "#3");
  });

  it("turns null labels into an empty array", () => {
    assert.deepEqual(toLeanTask(bareTask).labels, []);
  });

  it("flattens labels to titles", () => {
    const labels = [
      { id: 5, title: "feature" },
      { id: 6, title: "urgent" },
    ];
    assert.deepEqual(toLeanTask({ ...bareTask, labels }).labels, ["feature", "urgent"]);
  });

  it("omits priority when unset", () => {
    assert.equal("priority" in toLeanTask(bareTask), false);
  });

  it("keeps a real priority", () => {
    assert.equal(toLeanTask({ ...bareTask, priority: 3 }).priority, 3);
  });

  it("omits the zero due date", () => {
    assert.equal("due" in toLeanTask(bareTask), false);
  });

  it("keeps a real due date", () => {
    const due = "2026-08-01T09:00:00Z";
    assert.equal(toLeanTask({ ...bareTask, due_date: due }).due, due);
  });

  it("never carries a description", () => {
    const raw = { ...bareTask, description: "<p>should not leak into a listing</p>" };
    assert.equal("description" in toLeanTask(raw), false);
  });
});

describe("toLeanTaskDetail", () => {
  it("omits an empty description", () => {
    assert.equal("description" in toLeanTaskDetail(bareTask), false);
  });

  it("omits a description cleared in the UI", () => {
    assert.equal("description" in toLeanTaskDetail({ ...bareTask, description: "<p></p>" }), false);
  });

  it("converts the description to markdown", () => {
    const raw = { ...bareTask, description: "<h2>Plan</h2><p>Ship <strong>today</strong></p>" };
    assert.equal(toLeanTaskDetail(raw).description, "## Plan\n\nShip **today**");
  });
});

describe("toLeanProject / toLeanLabel", () => {
  it("maps the project identifier to key", () => {
    assert.deepEqual(toLeanProject({ ...bareProject, identifier: "INFRA" }), {
      key: "INFRA",
      id: 5,
      title: "Infrastructure",
    });
  });

  it("keeps an empty key for a project with no identifier", () => {
    assert.equal(toLeanProject({ ...bareProject, identifier: "" }).key, "");
  });

  it("drops the fields a listing has no use for", () => {
    const lean = toLeanProject({ ...bareProject, description: "<p>noise</p>" });
    assert.deepEqual(Object.keys(lean).sort(), ["id", "key", "title"]);
  });

  it("marks an archived project, whose tasks no task listing can return", () => {
    const lean = toLeanProject({ ...bareProject, is_archived: true });
    assert.equal(lean.archived, true);
    assert.deepEqual(Object.keys(lean).sort(), ["archived", "id", "key", "title"]);
  });

  it("omits the flag on a live project rather than carrying a false", () => {
    assert.equal("archived" in toLeanProject(bareProject), false);
  });

  it("maps a label", () => {
    assert.deepEqual(toLeanLabel({ id: 5, title: "feature" }), { id: 5, title: "feature" });
  });
});

describe("htmlToMarkdown", () => {
  it("converts real HTML", () => {
    assert.equal(
      htmlToMarkdown("<h1>Title</h1><p>Some <strong>bold</strong></p>"),
      "# Title\n\nSome **bold**",
    );
  });

  it("passes legacy raw markdown through untouched", () => {
    const legacy = "Fix **bold** now\nnext line";
    assert.equal(htmlToMarkdown(legacy), legacy);
  });

  it("keeps a markdown autolink in legacy raw markdown", () => {
    const legacy = "See <https://example.com> for **details**";
    assert.equal(htmlToMarkdown(legacy), legacy);
  });

  it("keeps an email autolink in legacy raw markdown", () => {
    const legacy = "Ping <ev@example.com> about **this**";
    assert.equal(htmlToMarkdown(legacy), legacy);
  });

  it("preserves checkbox state from a TipTap task list", () => {
    assert.equal(htmlToMarkdown(TIPTAP_TASK_LIST), "- [x] done thing\n- [ ] open thing");
  });

  it("preserves checkbox state when the input is a direct child", () => {
    const plain =
      '<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> open</li></ul>';
    assert.equal(htmlToMarkdown(plain), "- [x] done\n- [ ] open");
  });

  it("preserves table structure from TipTap", () => {
    assert.equal(
      htmlToMarkdown(TIPTAP_TABLE),
      "| Env | URL |\n| --- | --- |\n| prod | https://a.example |",
    );
  });

  it("returns an empty string for a description cleared in the UI", () => {
    assert.equal(htmlToMarkdown("<p></p>"), "");
  });

  it("returns an empty string for whitespace", () => {
    assert.equal(htmlToMarkdown("   "), "");
  });
});

describe("markdownToHtml", () => {
  it("returns an empty string for blank input", () => {
    assert.equal(markdownToHtml("   "), "");
  });

  it("converts ordinary markdown", () => {
    assert.equal(
      markdownToHtml("# Title\n\n**bold**"),
      "<h1>Title</h1>\n<p><strong>bold</strong></p>",
    );
  });

  it("keeps an ordinary link", () => {
    assert.equal(
      markdownToHtml("[docs](https://example.com)"),
      '<p><a href="https://example.com">docs</a></p>',
    );
  });

  it("escapes a raw script block", () => {
    const html = markdownToHtml("Hello\n\n<script>alert(document.cookie)</script>");
    assert.equal(html.includes("<script"), false);
    assert.match(html, /&lt;script&gt;/);
  });

  it("escapes raw inline HTML", () => {
    const html = markdownToHtml("text <img src=x onerror=alert(1)> more");
    assert.equal(html.includes("<img"), false);
    assert.match(html, /&lt;img/);
  });

  it("strips a javascript: link but keeps its text", () => {
    const html = markdownToHtml("[click](javascript:alert(1))");
    assert.equal(html.includes("javascript:"), false);
    assert.match(html, /click/);
  });

  it("strips a javascript: image but keeps its alt text", () => {
    const html = markdownToHtml("![boom](javascript:alert(1))");
    assert.equal(html.includes("javascript:"), false);
  });

  it("keeps a mailto link", () => {
    assert.match(markdownToHtml("[mail](mailto:ev@example.com)"), /href="mailto:ev@example.com"/);
  });
});

describe("round trip", () => {
  /** These survive markdown -> HTML -> markdown byte for byte. */
  for (const markdown of [
    "# Title\n\nSome **bold** text",
    "- [x] done thing\n- [ ] open thing",
    "| Env | Owner |\n| --- | --- |\n| prod | platform |",
    "```js\nconst x = 1;\n```",
    "See [the docs](https://example.com)",
  ]) {
    it(`is stable for ${JSON.stringify(markdown.slice(0, 24))}`, () => {
      assert.equal(htmlToMarkdown(markdownToHtml(markdown)), markdown);
    });
  }

  /**
   * A bare URL comes back as an explicit link: marked's GFM autolinker promotes
   * it on the way out and turndown writes the promotion down. Idempotent from
   * the second pass on, so it settles rather than growing.
   */
  it("promotes a bare URL to an explicit link, once", () => {
    const once = htmlToMarkdown(markdownToHtml("Deployed to https://a.example today"));
    assert.equal(once, "Deployed to [https://a.example](https://a.example) today");
    assert.equal(htmlToMarkdown(markdownToHtml(once)), once);
  });

  /**
   * These do not, and that is turndown's escaping doing its job: the result
   * re-renders identically, and a second pass is a fixed point rather than
   * piling on more backslashes. Pinned so a future change has to be deliberate.
   */
  it("escapes markdown-significant characters, but only once", () => {
    const once = htmlToMarkdown(markdownToHtml("Cost is 2 * 3 and file_name_here"));
    assert.equal(once, "Cost is 2 \\* 3 and file\\_name\\_here");
    assert.equal(htmlToMarkdown(markdownToHtml(once)), once);
  });
});

describe("toTaskWrite", () => {
  it("maps nothing when nothing was passed, so an update patches nothing", () => {
    assert.deepEqual(toTaskWrite({}), {});
  });

  it("renames due to the column Vikunja writes", () => {
    assert.deepEqual(toTaskWrite({ due: "2026-07-25T09:00:00Z" }), {
      due_date: "2026-07-25T09:00:00Z",
    });
  });

  it("converts a markdown description to HTML", () => {
    assert.deepEqual(toTaskWrite({ description: "a **body**" }), {
      description: "<p>a <strong>body</strong></p>",
    });
  });

  it("clears a due date with Vikunja's own zero timestamp, since there is no null to send", () => {
    assert.deepEqual(toTaskWrite({ due: "" }), { due_date: "0001-01-01T00:00:00Z" });
  });

  it("clears a description with the empty string the server stores", () => {
    assert.deepEqual(toTaskWrite({ description: "" }), { description: "" });
  });

  it("keeps a false and a zero, which are values rather than absences", () => {
    assert.deepEqual(toTaskWrite({ done: false, priority: 0 }), { done: false, priority: 0 });
  });

  it("omits a field left undefined next to one that was passed", () => {
    assert.deepEqual(toTaskWrite({ title: "new", description: undefined }), { title: "new" });
  });
});
