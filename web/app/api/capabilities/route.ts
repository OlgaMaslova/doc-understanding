/**
 * Whether this instance can run the pipeline.
 *
 * The UI asks first so it can render an honest control rather than a button that
 * fails on click. Reports booleans and a display reason only — never a key, never
 * a filesystem path beyond what the reason text needs to be actionable.
 */

import { capabilities } from "@/lib/runner";
import { MAX_LIMIT } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const caps = await capabilities();
  return Response.json(
    { ...caps, maxLimit: MAX_LIMIT },
    { headers: { "cache-control": "no-store" } },
  );
}
