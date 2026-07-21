/**
 * Runtime configuration, sourced entirely from environment variables.
 * The server talks to exactly one host — VIKUNJA_URL — and nowhere else.
 */
export interface Config {
  /** Base REST URL, e.g. http://localhost:3456/api/v1 (no trailing slash). */
  baseUrl: string;
  /** Vikunja API token. */
  token: string;
}

const DEFAULT_URL = "http://localhost:3456/api/v1";

/** The only schemes the one host may be reached over. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export function loadConfig(): Config {
  const rawUrl = process.env.VIKUNJA_URL ?? DEFAULT_URL;
  const token = process.env.VIKUNJA_API_TOKEN;

  if (!token) {
    throw new Error(
      "VIKUNJA_API_TOKEN is not set. Export a Vikunja API token before starting the server.",
    );
  }

  return {
    baseUrl: parseBaseUrl(rawUrl),
    token,
  };
}

/**
 * Every request is `baseUrl` + a path, so a base URL that does not parse costs nothing at
 * startup and then fails each tool call with a bare `Invalid URL` — a message that names
 * neither the variable nor the value behind it. An empty `VIKUNJA_URL` is the same story with
 * one extra turn: it is not nullish, so it slips past the `??` above and the server reports
 * itself ready against a host it never had.
 *
 * The scheme is pinned here too. The client refuses redirects because a compromised Vikunja
 * could otherwise hand our traffic — token attached — to another origin; leaving the scheme
 * unchecked lets a plain `http://` typo in an otherwise `https://` deployment hand the same
 * traffic to anyone on the path, no compromise of the server required.
 */
function parseBaseUrl(rawUrl: string): string {
  const value = rawUrl.trim();

  if (value === "") {
    throw new Error(
      `VIKUNJA_URL is set but empty. Point it at the Vikunja API root (e.g. ${DEFAULT_URL}), or leave it unset to use that default.`,
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `VIKUNJA_URL is not a valid URL: "${value}". Give the absolute URL of the Vikunja API ` +
        `root, which usually ends in /api/v1 (e.g. ${DEFAULT_URL}).`,
    );
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(
      `VIKUNJA_URL must use http:// or https://, got "${url.protocol}//" in "${value}".`,
    );
  }

  // `href`, not the raw string, so that what was validated is what every request is built from,
  // with the host normalised the way `fetch` would have normalised it anyway.
  return url.href.replace(/\/+$/, "");
}
