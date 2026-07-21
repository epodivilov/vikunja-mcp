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

export function loadConfig(): Config {
  const rawUrl = process.env.VIKUNJA_URL ?? "http://localhost:3456/api/v1";
  const token = process.env.VIKUNJA_API_TOKEN;

  if (!token) {
    throw new Error(
      "VIKUNJA_API_TOKEN is not set. Export a Vikunja API token before starting the server.",
    );
  }

  return {
    baseUrl: rawUrl.replace(/\/+$/, ""),
    token,
  };
}
