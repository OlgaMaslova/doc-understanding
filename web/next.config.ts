import type { NextConfig } from "next";

/**
 * The static build.
 *
 * This branch exists to be deployed to GitHub Pages, which serves files and runs
 * nothing. Everything the site shows is written at build time out of the committed
 * `results/`: the pages by the export, the replay bundles by `scripts/build-replay.mjs`.
 *
 * `basePath` is what a project site needs — `https://<user>.github.io/<repo>/`. It is
 * empty in development so `npm run dev` serves from the root, and settable for a
 * deployment that is not at `/doc-understanding` (a fork under another name, a custom
 * domain at a root) by exporting `NEXT_PUBLIC_BASE_PATH`.
 *
 * Whatever it resolves to is re-exported through `env`, so `lib/site.ts` — which has
 * to prepend the prefix to the bundles it fetches, the one thing Next does not do
 * itself — reads the resolved value rather than repeating this expression.
 */
const basePath =
  process.env.NEXT_PUBLIC_BASE_PATH ??
  (process.env.NODE_ENV === "production" ? "/doc-understanding" : "");

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  // /foo -> /foo/index.html, so a static host resolves a directory URL without
  // rewrite rules of its own. GitHub Pages has none.
  trailingSlash: true,
};

export default nextConfig;
