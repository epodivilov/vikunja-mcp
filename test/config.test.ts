/**
 * These cover the startup half of the contract: a VIKUNJA_URL that cannot be used has to fail
 * in `loadConfig`, with a message naming the variable — not once per request, inside the client,
 * as a bare `Invalid URL`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";

const originalUrl = process.env.VIKUNJA_URL;
const originalToken = process.env.VIKUNJA_API_TOKEN;

/** Loads with VIKUNJA_URL set to `url`, or with it unset when `url` is undefined. */
function load(url: string | undefined) {
  if (url === undefined) {
    Reflect.deleteProperty(process.env, "VIKUNJA_URL");
  } else {
    process.env.VIKUNJA_URL = url;
  }
  process.env.VIKUNJA_API_TOKEN = "test-token";
  return loadConfig();
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

  it("rejects an empty VIKUNJA_URL instead of treating it as unset", () => {
    assert.throws(() => load(""), /VIKUNJA_URL is set but empty/);
  });

  it("rejects a whitespace-only VIKUNJA_URL", () => {
    assert.throws(() => load("   "), /VIKUNJA_URL is set but empty/);
  });

  it("rejects a value that is not a URL, quoting what it was given", () => {
    assert.throws(() => load("not-a-url"), /VIKUNJA_URL is not a valid URL: "not-a-url"/);
  });

  it("rejects a relative path, which cannot address a host", () => {
    assert.throws(() => load("/api/v1"), /VIKUNJA_URL is not a valid URL/);
  });

  it("rejects a scheme other than http or https", () => {
    assert.throws(() => load("ftp://tasks.example.com/api/v1"), /must use http:\/\/ or https:\/\//);
    assert.throws(() => load("file:///etc/passwd"), /must use http:\/\/ or https:\/\//);
  });
});
