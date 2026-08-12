"use client";

import { useId, useMemo, useState } from "react";

import { ARM_COLOR, percent, usd } from "@/lib/format";
import type { ArmEconomics, ArmId, Manifest } from "@/lib/types";

/**
 * Total cost against number of queries answered.
 *
 * Each arm is a straight line: the y-intercept is what it cost before the first
 * query (indexing, extraction, one cache write) and the slope is what each
 * additional query costs. That decomposition is the entire argument. Where two
 * lines cross is the query volume at which one approach becomes cheaper than the
 * other, and switching documents moves those crossings — which is the thing
 * everybody writes about and nobody lets you watch.
 *
 * The y axis is logarithmic because the arms are four orders of magnitude apart
 * on the 10-K. On a linear axis, most of the lines would be flat against the
 * bottom of the chart.
 */

const WIDTH = 760;
const HEIGHT = 400;
const PAD = { top: 20, right: 168, bottom: 46, left: 66 };

const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

const QUERY_STOPS = [1, 10, 100, 1_000, 10_000];

/**
 * Accuracy an arm has to clear before the "cheapest at" row will recommend it.
 *
 * 0.8 is a judgement call, not a standard, which is why the caption states the
 * number rather than leaving the reader to infer it. The point is only that
 * "cheapest" and "cheapest that works" are different questions, and the second
 * one is the one a reader is actually asking.
 */
const SCORE_FLOOR = 0.8;

interface Props {
  economics: Partial<Record<ArmId, ArmEconomics>>;
  arms: Manifest["arms"];
  maxQueries?: number;
}

function costAt(e: ArmEconomics, queries: number): number {
  return e.fixed_cost_usd + e.marginal_cost_usd * queries;
}

/**
 * Quantise a coordinate before it reaches an SVG attribute.
 *
 * `Math.log10` is implementation-approximated, so Node and the browser can
 * disagree in the last bit — 84.38294785115717 against 84.38294785115718. React
 * compares the serialised attribute strings, so that one bit is a hydration
 * mismatch. Two decimals is far below a pixel in a 760x400 viewBox.
 */
function px(n: number): number {
  return Math.round(n * 100) / 100;
}

export function CostChart({ economics, arms, maxQueries = 10_000 }: Props) {
  const titleId = useId();
  const [hovered, setHovered] = useState<ArmId | null>(null);

  const present = useMemo(
    () => arms.filter((a) => economics[a.id]),
    [arms, economics],
  );

  const { yMin, yMax } = useMemo(() => {
    const values: number[] = [];
    for (const a of present) {
      const e = economics[a.id]!;
      values.push(costAt(e, 1), costAt(e, maxQueries));
    }
    const positives = values.filter((v) => v > 0);
    const lo = positives.length ? Math.min(...positives) : 0.0001;
    const hi = Math.max(...values, lo * 10);
    // Round to decade boundaries so the gridlines land on readable numbers.
    // `1e${n}` rather than Math.pow, which is another approximated function and
    // would put engine-dependent noise into the tick labels.
    return {
      yMin: Number(`1e${Math.floor(Math.log10(lo))}`),
      yMax: Number(`1e${Math.ceil(Math.log10(hi))}`),
    };
  }, [present, economics, maxQueries]);

  const x = (queries: number) =>
    px(PAD.left + (Math.log10(queries) / Math.log10(maxQueries)) * PLOT_W);
  const y = (cost: number) => {
    const clamped = Math.max(cost, yMin);
    const t =
      (Math.log10(clamped) - Math.log10(yMin)) /
      (Math.log10(yMax) - Math.log10(yMin));
    return px(PAD.top + PLOT_H - t * PLOT_H);
  };

  const yTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let v = yMin; v <= yMax * 1.0001; v *= 10) ticks.push(v);
    return ticks;
  }, [yMin, yMax]);

  /**
   * Query volumes where an arm's line crosses another's. These are the numbers
   * the reader actually wants — "cheaper past N queries" — so they get drawn
   * rather than left to be eyeballed off the lines.
   */
  const crossings = useMemo(() => {
    const out: { queries: number; cost: number; a: ArmId; b: ArmId }[] = [];
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const ea = economics[present[i].id]!;
        const eb = economics[present[j].id]!;
        const dSlope = ea.marginal_cost_usd - eb.marginal_cost_usd;
        if (Math.abs(dSlope) < 1e-12) continue;
        const q = (eb.fixed_cost_usd - ea.fixed_cost_usd) / dSlope;
        if (q > 1 && q < maxQueries) {
          out.push({
            queries: q,
            cost: costAt(ea, q),
            a: present[i].id,
            b: present[j].id,
          });
        }
      }
    }
    return out;
  }, [present, economics, maxQueries]);

  const visibleCrossings = hovered
    ? crossings.filter((c) => c.a === hovered || c.b === hovered)
    : crossings;

  /**
   * Cheapest at each volume — among arms that actually answer the questions.
   *
   * Ranking on cost alone crowns whichever arm is most willing to be wrong: on
   * the 10-K that is naive chunk RAG, which scores 57%. Printing it as the answer
   * directly contradicts the heatmap immediately below, whose own subtitle is
   * "cheap is only interesting if it is also right".
   *
   * So the ranking is gated on an accuracy floor, and the floor is stated in the
   * caption rather than hidden here. This is a presentation choice, not a claim:
   * every arm's real cost is still drawn on the chart, and an arm excluded from
   * this row is excluded visibly, with its score shown.
   */
  const cheapestAt = useMemo(
    () =>
      QUERY_STOPS.filter((q) => q <= maxQueries).map((queries) => {
        const ranked = present
          .map((a) => ({
            arm: a.id,
            cost: costAt(economics[a.id]!, queries),
            score: economics[a.id]!.score,
          }))
          .sort((a, b) => a.cost - b.cost);
        const eligible = ranked.filter((r) => r.score >= SCORE_FLOOR);
        const best = eligible[0] ?? ranked[0];
        // What ranking on price alone would have said, when that differs.
        const naive = ranked[0];
        return {
          queries,
          ...best,
          excluded: naive.arm !== best.arm ? naive : null,
          anyEligible: eligible.length > 0,
        };
      }),
    [present, economics, maxQueries],
  );

  /**
   * The headline comparison, in words: cached full context against the cheapest
   * retrieval arm, per query.
   *
   * This is the one number the project is about. Below roughly parity, caching
   * has erased retrieval's cost advantage and you may as well keep the whole
   * document. Several times over, retrieval has won and the crossover has been
   * passed. Stating the ratio makes the finding survive a reader who looks at the
   * chart for eight seconds and leaves.
   */
  const headline = useMemo(() => {
    const cached = economics.cached_context_1h;
    const retrievalArms: ArmId[] = ["naive_rag", "hybrid_rag"];
    const retrieval = retrievalArms
      .map((id) => economics[id])
      .filter((e): e is ArmEconomics => Boolean(e))
      .sort((a, b) => a.marginal_cost_usd - b.marginal_cost_usd)[0];
    if (!cached || !retrieval || retrieval.marginal_cost_usd <= 0) return null;

    const ratio = cached.marginal_cost_usd / retrieval.marginal_cost_usd;
    const cheapest = retrievalArms
      .filter((id) => economics[id])
      .sort(
        (a, b) =>
          economics[a]!.marginal_cost_usd - economics[b]!.marginal_cost_usd,
      )[0];
    const retrievalLabel = arms.find((a) => a.id === cheapest)?.label ?? cheapest;

    if (ratio < 1) {
      return `On this document, keeping the whole thing in context and caching it costs ${(1 / ratio).toFixed(1)}× less per query than ${retrievalLabel} — and throws nothing away. Caching has erased retrieval's cost advantage.`;
    }
    if (ratio < 1.5) {
      return `On this document, cached full context costs about the same per query as ${retrievalLabel} (${ratio.toFixed(2)}×) — while being strictly more accurate, because nothing was discarded. This is where the cost argument for retrieval stops working.`;
    }
    return `On this document, cached full context costs ${ratio.toFixed(1)}× what ${retrievalLabel} costs per query, because cache reads scale with document size and retrieval does not. The crossover has been passed — this is the size where retrieval starts earning its accuracy cost.`;
  }, [economics, arms]);

  return (
    <figure className="m-0">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-labelledby={titleId}
          className="block h-auto w-full min-w-[640px]"
        >
          <title id={titleId}>
            Total cost against number of queries, one line per measured run. Fixed
            indexing costs are the starting height of each line; the slope is the
            cost of each additional query.
          </title>

          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={PAD.left + PLOT_W}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 10}
                y={y(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                className="tnum"
                fontSize={11}
                fill="var(--text-faint)"
              >
                {usd(tick)}
              </text>
            </g>
          ))}

          {QUERY_STOPS.filter((q) => q <= maxQueries).map((q) => (
            <g key={q}>
              <line
                x1={x(q)}
                x2={x(q)}
                y1={PAD.top}
                y2={PAD.top + PLOT_H}
                stroke="var(--border)"
                strokeWidth={1}
                strokeDasharray={q === 1 ? undefined : "2 4"}
              />
              <text
                x={x(q)}
                y={PAD.top + PLOT_H + 18}
                textAnchor="middle"
                className="tnum"
                fontSize={11}
                fill="var(--text-faint)"
              >
                {q.toLocaleString()}
              </text>
            </g>
          ))}

          <text
            x={PAD.left + PLOT_W / 2}
            y={HEIGHT - 6}
            textAnchor="middle"
            fontSize={11}
            fill="var(--text-dim)"
          >
            queries answered
          </text>
          <text
            x={14}
            y={PAD.top + PLOT_H / 2}
            textAnchor="middle"
            fontSize={11}
            fill="var(--text-dim)"
            transform={`rotate(-90 14 ${PAD.top + PLOT_H / 2})`}
          >
            total cost
          </text>

          {visibleCrossings.map((c, i) => (
            <g key={`${c.a}-${c.b}-${i}`}>
              <line
                x1={x(c.queries)}
                x2={x(c.queries)}
                y1={y(c.cost)}
                y2={PAD.top + PLOT_H}
                stroke="var(--border-strong)"
                strokeWidth={1}
                strokeDasharray="1 3"
              />
              <circle
                cx={x(c.queries)}
                cy={y(c.cost)}
                r={3}
                fill="var(--bg)"
                stroke="var(--text-dim)"
                strokeWidth={1.5}
              />
            </g>
          ))}

          {present.map((arm) => {
            const e = economics[arm.id]!;
            const dim = hovered !== null && hovered !== arm.id;
            const endCost = costAt(e, maxQueries);
            return (
              <g
                key={arm.id}
                opacity={dim ? 0.22 : 1}
                onMouseEnter={() => setHovered(arm.id)}
                onMouseLeave={() => setHovered(null)}
              >
                <line
                  x1={x(1)}
                  y1={y(costAt(e, 1))}
                  x2={x(maxQueries)}
                  y2={y(endCost)}
                  stroke={ARM_COLOR[arm.id]}
                  strokeWidth={hovered === arm.id ? 3 : 2}
                  strokeLinecap="round"
                />
                {/* A fat transparent line gives the thin stroke a usable hit area. */}
                <line
                  x1={x(1)}
                  y1={y(costAt(e, 1))}
                  x2={x(maxQueries)}
                  y2={y(endCost)}
                  stroke="transparent"
                  strokeWidth={14}
                />
                <text
                  x={PAD.left + PLOT_W + 10}
                  y={y(endCost)}
                  dominantBaseline="middle"
                  fontSize={11}
                  fill={ARM_COLOR[arm.id]}
                >
                  {arm.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Which approach is cheapest at each volume is the decision the chart is
          for, and it is easier to read as a row of answers than as a list of
          crossing points. Switching documents changes this row, which is the
          finding the whole project is built around. */}
      <figcaption className="mt-4">
        <div className="mb-2 text-xs uppercase tracking-wide text-text-faint">
          Cheapest at, among approaches scoring{" "}
          <span className="tnum">{Math.round(SCORE_FLOOR * 100)}%</span> or better
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-5">
          {cheapestAt.map(
            ({ queries, arm, cost, score, excluded, anyEligible }) => (
              <div key={queries}>
                <dt className="tnum text-xs text-text-faint">
                  {queries.toLocaleString()}{" "}
                  {queries === 1 ? "query" : "queries"}
                </dt>
                <dd className="text-sm" style={{ color: ARM_COLOR[arm] }}>
                  {arms.find((a) => a.id === arm)?.label ?? arm}
                </dd>
                <dd className="tnum text-xs text-text-faint">
                  {usd(cost)}
                  {anyEligible ? (
                    <span className="ml-1">· {percent(score)}</span>
                  ) : (
                    <span className="ml-1 text-[#d9a441]">
                      · nothing clears the floor
                    </span>
                  )}
                </dd>
                {/* Naming what price alone would have picked is the honest way to
                    apply a floor: the reader can see the trade being made rather
                    than just the conclusion. */}
                {excluded ? (
                  <dd className="mt-0.5 text-[11px] text-text-faint">
                    cheaper but{" "}
                    <span className="tnum">{percent(excluded.score)}</span>:{" "}
                    {arms.find((a) => a.id === excluded.arm)?.label}
                  </dd>
                ) : null}
              </div>
            ),
          )}
        </dl>

        {/* The crossing this project exists to show, called out by name.
            Every pairwise crossing is already marked with a dot, but "cached full
            context against retrieval" is the argument, and leaving the reader to
            find it among twenty dots buries it. */}
        {headline ? (
          <p className="mt-4 border-l-2 border-accent pl-3 text-sm leading-relaxed text-text-dim">
            {headline}
          </p>
        ) : null}
        {hovered && visibleCrossings.length > 0 ? (
          <p className="mt-3 text-sm leading-relaxed text-text-dim">
            <span className="text-text">
              {arms.find((a) => a.id === hovered)?.label}
            </span>{" "}
            crosses another line at{" "}
            {visibleCrossings
              .slice()
              .sort((a, b) => a.queries - b.queries)
              .map((c, i) => {
                const other = c.a === hovered ? c.b : c.a;
                return (
                  <span key={`${c.a}-${c.b}-${i}`}>
                    {i > 0 ? ", " : ""}
                    <span className="tnum">
                      {Math.round(c.queries).toLocaleString()}
                    </span>{" "}
                    ({arms.find((a) => a.id === other)?.label ?? other})
                  </span>
                );
              })}
            .
          </p>
        ) : (
          <p className="mt-3 text-sm leading-relaxed text-text-dim">
            Hover a line to see where it crosses the others. Dots mark every
            crossing point.
          </p>
        )}
      </figcaption>
    </figure>
  );
}
