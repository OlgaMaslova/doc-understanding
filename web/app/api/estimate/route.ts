/**
 * Price a run scope. Spends nothing.
 *
 * Gated the same way as the run route, for one reason worth stating: pricing a
 * scope is free, but an ungated endpoint that shells out to Python on request is
 * a liability regardless of what it costs. Same gates, same refusal.
 */

import { loadCatalogue } from "@/lib/catalogue";
import { loadPresets, questionCount } from "@/lib/presets";
import { capabilities, estimateScope, MAX_RUN_USD } from "@/lib/runner";
import { isScopeError, parseScope } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const caps = await capabilities();
  if (!caps.canRun) {
    return Response.json({ error: caps.reason }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const catalogue = await loadCatalogue();
  const presets = await loadPresets();
  const scope = parseScope(
    body,
    catalogue.map((d) => d.doc_id),
    presets.models,
  );
  if (isScopeError(scope)) {
    return Response.json({ error: scope.error }, { status: 400 });
  }

  const questions = questionCount(presets, scope.doc);
  if (questions === 0) {
    return Response.json(
      { error: `No questions are defined for ${scope.doc} in data/questions.yaml.` },
      { status: 400 },
    );
  }

  try {
    const estimate = await estimateScope(scope, questions);
    return Response.json({
      ...estimate,
      questions,
      max_run_usd: MAX_RUN_USD,
      // Reported rather than enforced here: this endpoint only prices. The run
      // route re-derives it, so a client cannot talk its way past the ceiling by
      // ignoring this field.
      within_cap: estimate.total_usd <= MAX_RUN_USD,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Estimate failed." },
      { status: 500 },
    );
  }
}
