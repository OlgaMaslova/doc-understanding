/**
 * Turn the committed results into static replay bundles.
 *
 * The comparison cards need each arm's answer, and on the deployed site there is no
 * route handler left to stream one. So every result set is written once, at build
 * time, into `public/replay/` — where `next build` copies it into the export — and
 * the browser fetches the bundle for whichever document it is showing.
 *
 * One thing is dropped on the way through, and it is about half the weight: the delta
 * streams. Every answer was recorded fragment by fragment with arrival times, and
 * nothing reads them any more — the replay is instant. What is left is each cell's
 * answer and the numbers printed on its card, which is still 200–260 KB per document,
 * fetched only for the document on screen.
 *
 * Run by `npm run build` via `prebuild`. Reads `../results`, which is committed on
 * this branch precisely so a deploy needs no keys and no pipeline.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const RESULTS_DIR = path.join(process.cwd(), "..", "results");
const OUT_DIR = path.join(process.cwd(), "public", "replay");

/** One cell, reduced to what `ArmCard` renders. */
function leanCell(cell) {
  if ("error" in cell) return { error: cell.error };
  return {
    answer: cell.answer,
    latency_ms: cell.latency_ms,
    ttft_ms: cell.ttft_ms,
    cost: cell.cost,
    usage: cell.usage,
    grade: cell.grade,
    notes: cell.notes,
  };
}

async function main() {
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(RESULTS_DIR, "manifest.json"), "utf8"),
    );
  } catch {
    // No results at all is a broken deploy of this branch, not a state to paper
    // over: the site has nothing to show and the build should say so out loud
    // rather than exporting an empty page.
    console.error(
      "No results/manifest.json. This branch deploys committed measurements; " +
        "there is nothing to build a site from.",
    );
    process.exit(1);
  }

  if (!Array.isArray(manifest.docs)) {
    console.error("results/manifest.json has no docs array; it is not a manifest.");
    process.exit(1);
  }

  // Stale bundles are worse than missing ones — a renamed or superseded result set
  // would go on being served next to the manifest that no longer lists it.
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  for (const entry of manifest.docs) {
    const file = path.basename(entry.file);
    const doc = JSON.parse(await readFile(path.join(RESULTS_DIR, file), "utf8"));
    if (!doc.cells || typeof doc.cells !== "object") {
      console.error(`results/${file} has no cells; it is not a result set.`);
      process.exit(1);
    }
    const cells = {};
    for (const [key, cell] of Object.entries(doc.cells)) {
      cells[key] = leanCell(cell);
    }
    const json = JSON.stringify({ doc_id: doc.doc_id, model: doc.model, cells });
    await writeFile(path.join(OUT_DIR, file), json);
    console.log(
      `replay/${file} — ${Object.keys(cells).length} cells, ${Math.round(json.length / 1024)} KB`,
    );
  }
}

await main();
