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
  parseHexColor,
  relatedProjectIds,
  toLabelWrite,
  toLeanBoard,
  toLeanColumn,
  toLeanComment,
  toLeanLabel,
  toLeanProject,
  toLeanTask,
  toLeanTaskDetail,
  toLeanUser,
  toTaskWrite,
} from "../src/projection.ts";
import type {
  RawComment,
  RawLabel,
  RawProject,
  RawTask,
  RawUser,
  TaskRefLookup,
} from "../src/types.ts";

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
  assignees: null,
};

/** A project as the API returns it. `description` and `is_archived` never reach the model. */
const bareProject: RawProject = {
  id: 5,
  title: "Infrastructure",
  identifier: "INFRA",
  description: "",
  is_archived: false,
};

/**
 * A comment as `GET /tasks/{id}/comments/{commentId}` answers it. `author` is a full user
 * object — the expanded-owner bloat this project exists to strip — and the server also sends
 * `reactions` and `updated`, kept here so the projection is shown dropping them.
 *
 * Field names read out of go-vikunja v2.3.0 `pkg/models/task_comments.go` (`comment`, `author`,
 * `created`) and `pkg/user/user.go` (`username`).
 */
const rawAuthor = {
  id: 3,
  name: "Evgenii Podivilov",
  username: "evgenii",
  email: "ev@example.com",
  created: "2025-01-04T09:00:00Z",
  updated: "2025-01-04T09:00:00Z",
};

const bareComment: RawComment & { updated: string; reactions: Record<string, unknown> } = {
  id: 91,
  comment: "<p>Ship it</p>",
  author: rawAuthor,
  created: "2026-07-24T18:21:09.315237Z",
  updated: "2026-07-24T18:21:09.315237Z",
  reactions: {},
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
    const labels: RawLabel[] = [
      { id: 5, title: "feature", description: "", hex_color: "" },
      { id: 6, title: "urgent", description: "", hex_color: "ff0000" },
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

  it("R6: flattens assignees to usernames, in the server's order", () => {
    const assignees: RawUser[] = [
      { id: 5, username: "bob", name: "" },
      { id: 3, username: "alice", name: "Alice A" },
    ];
    assert.deepEqual(toLeanTask({ ...bareTask, assignees }).assignees, ["bob", "alice"]);
  });

  it("R6: omits assignees entirely when the task has none", () => {
    assert.equal("assignees" in toLeanTask(bareTask), false, "null assignees");
    assert.equal("assignees" in toLeanTask({ ...bareTask, assignees: [] }), false, "empty list");
  });
});

/**
 * Project id -> identifier, as the resolver's index has it. Project 9 has none, which is what
 * makes its tasks render as `#index`.
 */
const IDENTIFIERS: Record<number, string> = { 7: "INFRA", 11: "VMCP", 9: "" };

/** The ref builder the resolver hands the projection, spelled out here so the test owns it. */
const refOf: TaskRefLookup = (projectId, index) => {
  const identifier = IDENTIFIERS[projectId] ?? "";
  return identifier === "" ? `#${index}` : `${identifier}-${index}`;
};

/**
 * A related task as `ReadOne` embeds it: a full task row whose `identifier` the server never
 * fills in — `setIdentifier` runs on the task being read and on nothing inside `related_tasks`.
 */
function relatedTask(
  id: number,
  projectId: number,
  index: number,
  title: string,
  done = false,
): RawTask {
  return { ...bareTask, id, project_id: projectId, index, identifier: "", title, done };
}

describe("toLeanTaskDetail", () => {
  it("omits an empty description", () => {
    assert.equal("description" in toLeanTaskDetail(bareTask, refOf), false);
  });

  it("omits a description cleared in the UI", () => {
    assert.equal(
      "description" in toLeanTaskDetail({ ...bareTask, description: "<p></p>" }, refOf),
      false,
    );
  });

  it("converts the description to markdown", () => {
    const raw = { ...bareTask, description: "<h2>Plan</h2><p>Ship <strong>today</strong></p>" };
    assert.equal(toLeanTaskDetail(raw, refOf).description, "## Plan\n\nShip **today**");
  });
});

describe("toLeanTaskDetail relations", () => {
  const related: RawTask = {
    ...bareTask,
    related_tasks: {
      blocking: [relatedTask(101, 11, 3, "Ship the client")],
      subtask: [
        relatedTask(102, 7, 12, "Write the tests", true),
        relatedTask(103, 9, 5, "Task of a project with no key"),
      ],
    },
  };

  it("R6: flattens the kind -> tasks map into one typed list", () => {
    assert.deepEqual(toLeanTaskDetail(related, refOf).relations, [
      { kind: "blocking", ref: "VMCP-3", title: "Ship the client", done: false },
      { kind: "subtask", ref: "INFRA-12", title: "Write the tests", done: true },
      { kind: "subtask", ref: "#5", title: "Task of a project with no key", done: false },
    ]);
  });

  it("R6: rebuilds every ref from index and project, never from the embedded identifier", () => {
    // The server sends "" there. A build that trusted it — or a stale one, as here — would
    // answer with a key that names a different task, which is the whole bug this guards.
    const lying: RawTask = {
      ...bareTask,
      related_tasks: { related: [{ ...relatedTask(101, 11, 3, "Ship"), identifier: "OLD-999" }] },
    };

    assert.deepEqual(toLeanTaskDetail(lying, refOf).relations, [
      { kind: "related", ref: "VMCP-3", title: "Ship", done: false },
    ]);
  });

  it("R6: a relation carries nothing but kind, ref, title and done", () => {
    const [relation] = toLeanTaskDetail(related, refOf).relations ?? [];
    assert.ok(relation);
    assert.deepEqual(Object.keys(relation).sort(), ["done", "kind", "ref", "title"]);
  });

  /** Every shape the server sends for "this task has no relations". */
  const empties: Array<[string, RawTask["related_tasks"]]> = [
    ["null, as a nil Go map serializes", null],
    ["an empty object, as an empty Go map serializes", {}],
    ["a kind whose array is empty", { related: [] }],
    ["a kind whose array is null", { related: null }],
  ];

  for (const [name, related_tasks] of empties) {
    it(`R6: carries no relations field when related_tasks is ${name}`, () => {
      assert.equal("relations" in toLeanTaskDetail({ ...bareTask, related_tasks }, refOf), false);
    });
  }

  it("R6: carries no relations field when the server omits related_tasks entirely", () => {
    assert.equal("relations" in toLeanTaskDetail(bareTask, refOf), false);
  });

  it("R6: a listing row still carries neither relations nor a description", () => {
    const lean = toLeanTask(related);
    assert.equal("relations" in lean, false);
    assert.equal("description" in lean, false);
  });

  it("R6: reports the projects whose identifiers the refs have to be built from", () => {
    assert.deepEqual(
      relatedProjectIds(related).sort((a, b) => a - b),
      [7, 9, 11],
    );
  });

  it("R6: reports no project to look up when there are no relations", () => {
    assert.deepEqual(relatedProjectIds(bareTask), []);
    assert.deepEqual(relatedProjectIds({ ...bareTask, related_tasks: null }), []);
    assert.deepEqual(relatedProjectIds({ ...bareTask, related_tasks: { related: [] } }), []);
  });

  it("R6: names each project once, however many related tasks it holds", () => {
    const many: RawTask = {
      ...bareTask,
      related_tasks: {
        blocking: [relatedTask(1, 11, 1, "a")],
        related: [relatedTask(2, 11, 2, "b"), relatedTask(3, 7, 3, "c")],
      },
    };

    assert.deepEqual(
      relatedProjectIds(many).sort((a, b) => a - b),
      [7, 11],
    );
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

  it("R7: maps a label to id, title and colour, dropping the raw fields around them", () => {
    // The server sends `created_by` (a whole user object) and a description alongside these
    // three; a projection that spread the raw label would hand both to the model.
    const raw = {
      id: 5,
      title: "feature",
      description: "kind marker",
      hex_color: "ff0000",
      created_by: { id: 3, username: "evgenii", name: "", email: "ev@example.com" },
    } as RawLabel;

    assert.deepEqual(toLeanLabel(raw), { id: 5, title: "feature", color: "ff0000" });
  });

  it("R7: reports a stored colour in one canonical form, whatever case it was stored in", () => {
    // 34 of the instance's 39 labels store upper-case hex ("0EA5E9"), so this is the normal
    // shape rather than an edge case — and an agent comparing two colours must not have to
    // fold case itself.
    const raw: RawLabel = { id: 45, title: "specified", description: "", hex_color: "0EA5E9" };

    assert.equal(toLeanLabel(raw).color, "0ea5e9");
  });

  it("R7: omits the colour key entirely for a label that has none", () => {
    const raw: RawLabel = { id: 46, title: "in-progress", description: "", hex_color: "" };

    assert.deepEqual(toLeanLabel(raw), { id: 46, title: "in-progress" });
    assert.equal("color" in toLeanLabel(raw), false);
  });
});

describe("parseHexColor", () => {
  it("R2: accepts six hex digits with or without the leading #, normalising both alike", () => {
    assert.equal(parseHexColor("#FF0000"), "ff0000");
    assert.equal(parseHexColor("ff0000"), "ff0000");
    assert.equal(parseHexColor(" #0EA5E9 "), "0ea5e9");
  });

  it("R2: refuses anything that is not six hex digits, naming the accepted form", () => {
    // Each of these is a shape the server would take and store as something else:
    // `red` passes its runelength(0|7) check and is stored as a colour nothing renders, and
    // `ff00001` is 7 runes — also accepted — which NormalizeHex silently truncates to `ff0000`.
    for (const bad of ["red", "#gggggg", "#ff00001", "ff00001", "fff", ""]) {
      assert.throws(
        () => parseHexColor(bad),
        /six hex digits/,
        `"${bad}" must be refused before it reaches the server`,
      );
    }
  });
});

describe("toLabelWrite", () => {
  it('R2: an empty colour is the clear — sent as "" rather than left out', () => {
    // Omission means "leave it alone" on the merge the client does, so clearing has to be
    // spelled: the key must be present and empty.
    const write = toLabelWrite({ color: "" });

    assert.deepEqual(write, { hex_color: "" });
    assert.equal("hex_color" in write, true);
  });

  it("R2/R3: a patch naming only a title carries no colour key at all", () => {
    const write = toLabelWrite({ title: "renamed" });

    assert.deepEqual(write, { title: "renamed" });
    assert.equal("hex_color" in write, false, "the stored colour is the client merge's to supply");
  });

  it("R2: a colour is normalised on the way to the API's own field name", () => {
    assert.deepEqual(toLabelWrite({ title: "bug", color: "#00FF00" }), {
      title: "bug",
      hex_color: "00ff00",
    });
  });

  it("R2: an unparseable colour is refused here, before any write", () => {
    assert.throws(() => toLabelWrite({ title: "bug", color: "red" }), /six hex digits/);
  });
});

describe("toLeanUser", () => {
  it("R5: keeps id and username only, dropping the email the API sends", () => {
    // Deliberately a variable rather than an inline literal: the extra field is what the server
    // actually sends, and a projection that spread the raw object would leak it here.
    const raw = { id: 3, username: "alice", name: "", email: "alice@example.com" };

    assert.deepEqual(toLeanUser(raw), { id: 3, username: "alice" });
  });

  it("R5: keeps a display name when the user has one", () => {
    const lean = toLeanUser({ id: 3, username: "alice", name: "Alice A" });

    assert.deepEqual(lean, { id: 3, username: "alice", name: "Alice A" });
  });

  it("R5: omits a blank name rather than sending the empty string back", () => {
    assert.equal("name" in toLeanUser({ id: 5, username: "bob", name: "" }), false);
    assert.equal("name" in toLeanUser({ id: 5, username: "bob", name: "  " }), false);
  });
});

describe("toLeanComment", () => {
  it("R5: converts the body to markdown and keeps only the author's username", () => {
    const raw = { ...bareComment, comment: "<p>Ship <strong>today</strong></p>" };

    // deepEqual on the whole DTO, not field by field: the point of the projection is what it
    // does NOT carry — the user object, reactions and `updated` all have to be gone.
    assert.deepEqual(toLeanComment(raw), {
      id: 91,
      comment: "Ship **today**",
      author: "evgenii",
      created: "2026-07-24T18:21:09.315237Z",
    });
  });

  it("R5: never lets the raw user object cross the boundary", () => {
    const lean = toLeanComment(bareComment);

    assert.equal(typeof lean.author, "string");
    assert.deepEqual(Object.keys(lean).sort(), ["author", "comment", "created", "id"]);
    assert.equal(JSON.stringify(lean).includes("ev@example.com"), false, "no author email");
  });

  it("R5: converts a TipTap task list, checkbox state and all", () => {
    const raw = { ...bareComment, comment: TIPTAP_TASK_LIST };

    assert.equal(toLeanComment(raw).comment, "- [x] done thing\n- [ ] open thing");
  });

  it("R5: passes a legacy raw-markdown body through unescaped", () => {
    const legacy = "Fix **bold** now\nnext line";
    const raw = { ...bareComment, comment: legacy };

    assert.equal(toLeanComment(raw).comment, legacy);
  });

  it("R5: omits the author when the server reports no user", () => {
    const raw = { ...bareComment, author: null };
    const lean = toLeanComment(raw);

    assert.equal("author" in lean, false);
    assert.deepEqual(lean, { id: 91, comment: "Ship it", created: "2026-07-24T18:21:09.315237Z" });
  });

  it("R5: omits the author when the user object carries no username", () => {
    const raw = { ...bareComment, author: { ...rawAuthor, username: "" } };

    assert.equal("author" in toLeanComment(raw), false);
  });

  it("R5: passes the created timestamp through verbatim", () => {
    // A real timestamp, not a `due_date`-style zero date — nothing here may nullable it away.
    const raw = { ...bareComment, created: "2020-02-29T23:59:59Z" };

    assert.equal(toLeanComment(raw).created, "2020-02-29T23:59:59Z");
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

describe("toLeanColumn / toLeanBoard", () => {
  const first: RawTask = { ...bareTask, id: 1, index: 1, identifier: "INFRA-1", title: "First" };
  const second: RawTask = {
    ...bareTask,
    id: 2,
    index: 2,
    identifier: "INFRA-2",
    title: "Second",
    done: true,
  };

  it("names a column by its bucket title and projects its tasks to lean rows", () => {
    assert.deepEqual(toLeanColumn({ id: 8, title: "Doing", tasks: [first] }), {
      name: "Doing",
      tasks: [{ ref: "INFRA-1", id: 1, title: "First", done: false, labels: [] }],
    });
  });

  it("turns a bucket carrying null tasks into an empty column", () => {
    assert.deepEqual(toLeanColumn({ id: 8, title: "Doing", tasks: null }), {
      name: "Doing",
      tasks: [],
    });
  });

  it("leaks neither the bucket id nor a raw task field into a column", () => {
    const column = toLeanColumn({ id: 8, title: "Doing", tasks: [first] });
    assert.deepEqual(Object.keys(column).sort(), ["name", "tasks"]);
    const [task] = column.tasks;
    assert.ok(task);
    assert.equal("project_id" in task, false);
    assert.equal("bucket_id" in task, false);
    assert.equal("description" in task, false);
  });

  it("carries a manual board's mode and its columns in the server's order", () => {
    const board = toLeanBoard("manual", [
      { id: 8, title: "Doing", tasks: [first] },
      { id: 9, title: "Done", tasks: [second] },
    ]);

    assert.equal(board.mode, "manual");
    assert.deepEqual(
      board.columns.map((column) => column.name),
      ["Doing", "Done"],
    );
    assert.deepEqual(board.columns[1]?.tasks, [
      { ref: "INFRA-2", id: 2, title: "Second", done: true, labels: [] },
    ]);
  });

  it("carries a filter board's synthesized columns with the same shape and mode filter", () => {
    const board = toLeanBoard("filter", [
      { id: 0, title: "Specified", tasks: [first] },
      { id: 1, title: "In Progress", tasks: [second] },
    ]);

    assert.equal(board.mode, "filter");
    assert.deepEqual(
      board.columns.map((column) => column.name),
      ["Specified", "In Progress"],
    );
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
