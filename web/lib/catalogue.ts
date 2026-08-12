import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * The documents the pipeline knows about, whether or not they have results.
 *
 * `results/` only contains what has actually been run, so a manifest-driven picker
 * shows a reader the documents that happen to exist and gives them no way to learn
 * that the others are possible. A run scoped to one document is the normal state
 * now, which made that the normal state of the page too.
 *
 * The source is `data/docs/*.json`, written by `docrace.documents` when it fetches
 * and normalizes a document — so a document appears here once its text has been
 * fetched, and moves into the manifest once it has been measured. Deliberately not
 * read from the manifest: the whole point is to name what the manifest is missing.
 */
export interface CatalogueDoc {
  doc_id: string;
  domain: string;
  title: string;
  tokens: number;
  license: string;
  provenance: string;
  source_url: string;
}

/** The shape `docrace.documents` writes. `url` here, `source_url` in results. */
interface NormalizedDoc {
  doc_id: string;
  domain: string;
  title: string;
  tokens: number;
  license: string;
  provenance: string;
  url: string;
}

const DOCS_DIR = path.join(process.cwd(), "..", "data", "docs");

export async function loadCatalogue(): Promise<CatalogueDoc[]> {
  let names: string[];
  try {
    names = await readdir(DOCS_DIR);
  } catch {
    // No fetched documents at all. The picker falls back to whatever has results,
    // which is the only thing it could show before this existed.
    return [];
  }

  const docs: CatalogueDoc[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(DOCS_DIR, name), "utf8");
      const doc = JSON.parse(raw) as NormalizedDoc;
      if (!doc.doc_id) continue;
      docs.push({
        doc_id: doc.doc_id,
        domain: doc.domain,
        title: doc.title,
        tokens: doc.tokens,
        license: doc.license,
        provenance: doc.provenance,
        source_url: doc.url ?? "",
      });
    } catch {
      // One malformed or half-written file must not take the page down; the
      // document simply doesn't offer itself until it parses.
      continue;
    }
  }

  // Ascending size. Document size is the variable this project exists to show, so
  // the picker reads as a ramp rather than as directory order.
  return docs.sort((a, b) => a.tokens - b.tokens);
}
