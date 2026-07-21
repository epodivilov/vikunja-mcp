/**
 * These cover the startup half of the contract: a VIKUNJA_URL that cannot be used has to fail
 * in `loadConfig`, with a message naming the variable — not once per request, inside the client,
 * as a bare `Invalid URL` or a 404 that names only the endpoint.
 *
 * What is asserted is that contract, not the prose: the message has to name VIKUNJA_URL and
 * quote the value at fault. Matching whole sentences would freeze the wording instead.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type Config, loadConfig } from "../src/config.ts";

const originalUrl = process.env.VIKUNJA_URL;
const originalToken = process.env.VIKUNJA_API_TOKEN;

/** Loads with VIKUNJA_URL set to `url`, or with it unset when `url` is undefined. */
function load(url: string | undefined): Config {
  if (url === undefined) {
    Reflect.deleteProperty(process.env, "VIKUNJA_URL");
  } else {
    process.env.VIKUNJA_URL = url;
  }
  process.env.VIKUNJA_API_TOKEN = "test-token";
  return loadConfig();
}

/**
 * Asserts the rejection is usable: it names the variable, and quotes `quoted` — the offending
 * value, or the part of it at fault. Omit `quoted` where there is nothing to quote back.
 */
function assertRejected(url: string, quoted?: string): void {
  assert.throws(
    () => load(url),
    (error: unknown) => {
      assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`);
      assert.ok(
        error.message.includes("VIKUNJA_URL"),
        `message does not name the variable: ${error.message}`,
      );
      if (quoted !== undefined) {
        assert.ok(
          error.message.includes(quoted),
          `message does not quote ${JSON.stringify(quoted)}: ${error.message}`,
        );
      }
      return true;
    },
  );
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = value;
  }
}

describe("loadConfig", () => {
  afterEach(() => {
    restore("VIKUNJA_URL", originalUrl);
    restore("VIKUNJA_API_TOKEN", originalToken);
  });

  it("falls back to the local default when VIKUNJA_URL is unset", () => {
    assert.equal(load(undefined).baseUrl, "http://localhost:3456/api/v1");
  });

  it("keeps a valid URL, minus trailing slashes", () => {
    assert.equal(
      load("https://tasks.example.com/api/v1//").baseUrl,
      "https://tasks.example.com/api/v1",
    );
  });

  /**
   * The parsed URL is what every request is built from, so the normalisation the parser applies
   * — lowercased host, default port dropped, IDN punycoded — has to survive into `baseUrl`.
   * Handing back the raw string would pass every other test here.
   */
  it("stores the parsed URL rather than the string it was given", () => {
    assert.equal(
      load("HTTPS://Tasks.Example.COM:443/api/v1").baseUrl,
      "https://tasks.example.com/api/v1",
    );
    assert.equal(
      load("https://münchen.example/api/v1").baseUrl,
      "https://xn--mnchen-3ya.example/api/v1",
    );
  });

  it("rejects an empty VIKUNJA_URL instead of treating it as unset", () => {
    assertRejected("");
  });

  it("rejects a whitespace-only VIKUNJA_URL", () => {
    assertRejected("   ");
  });

  it("rejects a value that is not a URL, quoting what it was given", () => {
    assertRejected("not-a-url", "not-a-url");
  });

  it("rejects a relative path, which cannot address a host", () => {
    assertRejected("/api/v1", "/api/v1");
  });

  it("rejects a scheme other than http or https", () => {
    assertRejected("ftp://tasks.example.com/api/v1", "ftp://tasks.example.com/api/v1");
    assertRejected("file:///etc/passwd", "file:///etc/passwd");
  });

  /**
   * A query or fragment on the base is not cosmetic: the client appends paths to `baseUrl`, so
   * either one displaces the path of every request it builds.
   */
  it("rejects a query string, which would displace the path of every request", () => {
    assertRejected("http://localhost:3456/api/v1?foo=bar", "?foo=bar");
  });

  it("rejects a fragment, which would collapse every endpoint onto one URL", () => {
    assertRejected("http://localhost:3456/api/v1#frag", "#frag");
  });

  /** Bare markers read empty through `url.search`/`url.hash`, yet `href` keeps them. */
  it("rejects a bare trailing ? or #, which the parsed URL reports as empty", () => {
    assertRejected("http://localhost:3456/api/v1?", "http://localhost:3456/api/v1?");
    assertRejected("http://localhost:3456/api/v1#", "http://localhost:3456/api/v1#");
  });
});
