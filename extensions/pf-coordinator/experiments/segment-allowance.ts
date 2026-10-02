// segment-allowance.ts — the analytic side (Method-B of the measurement plan).
//
// Given the empirical relative frequencies of segment types (from the trace), the
// expected number of distinct keys after `draws` independent occurrences is
//
//     D = Σ_i ( 1 − (1 − p_i)^T )
//
// and the expected repeat fraction is `1 − D/T`. Collisions concentrate in the
// "shared core" — types with `p_i ⪆ 1/T`. This turns a measured frequency histogram
// into a forecast of the collision rate at a different swarm size, before the run is
// paid for.
//
// Caveat, stated up front: the model draws occurrences i.i.d. from a fixed frequency
// distribution. Real flows have structure (one step per "slot"), so the forecast is a
// ceiling/trend for structured workloads, not an exact match — the structured measured
// rate sits below the i.i.d. ceiling. It is a model to fit, not an established law of
// agent reasoning.

/** Normalize occurrence counts into relative frequencies (each a proportion in [0,1]). */
export function relativeFrequencies(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  return counts.map((c) => c / total);
}

export interface AllowanceForecast {
  /** Total occurrences drawn (`T`). */
  draws: number;
  /** Expected distinct segment keys, `Σ (1 − (1 − p_i)^T)`. */
  distinct: number;
  /** Expected repeat fraction, `1 − distinct/draws`. */
  collisionRate: number;
  /** Number of segment types with `p_i ≥ 1/draws` — the shared core the collisions come from. */
  coreTypes: number;
}

export function forecastCollision(frequencies: number[], draws: number): AllowanceForecast {
  let distinct = 0;
  let coreTypes = 0;
  const threshold = draws > 0 ? 1 / draws : Infinity;
  for (const p of frequencies) {
    distinct += 1 - Math.pow(1 - p, draws);
    if (p >= threshold) coreTypes += 1;
  }
  return {
    draws,
    distinct,
    collisionRate: draws === 0 ? 0 : 1 - distinct / draws,
    coreTypes,
  };
}