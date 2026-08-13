/**
 * Facts about *this* deployment, as opposed to facts about the measurements.
 *
 * This branch builds a static export: `next build` writes HTML, the chart data, and
 * one replay bundle per result set, and a static host serves them. There is no
 * server, so there is nothing here that can start a run — the run flow lives in the
 * repository, and every place that used to offer a button now offers the link.
 */

/** Where the pipeline, the run flow, and everything else actually is. */
export const REPO_URL = "https://github.com/OlgaMaslova/doc-understanding";

/**
 * Path prefix the site is served under, empty when it is served from a root.
 *
 * GitHub Pages serves a project site from `/<repo>/`, and `next/link` handles that
 * from `basePath` alone. Fetches do not: the replay bundles are fetched by URL, so
 * the prefix has to be prepended by hand. `next.config.ts` resolves the value and
 * re-exports it here through `env`, so there is one definition rather than two
 * expressions that have to agree.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** URL of one replay bundle, as written by `scripts/build-replay.mjs`. */
export function replayUrl(file: string): string {
  return `${BASE_PATH}/replay/${file}`;
}
