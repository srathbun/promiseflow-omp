import { expect, test } from "bun:test";
import { continuationSavings } from "./savings-model.ts";

test("break-even is authoring cost over per-continuation savings", () => {
  const out = continuationSavings({ costPerContinuation: 1315, authoringTokens: 1000, redundantUnits: 1, extraAgentsPerUnit: 1, convergence: 1 });
  expect(out.breakEvenContinuations).toBeCloseTo(1000 / 1315);
  expect(out.avoidedContinuations).toBe(1);
  expect(out.grossSavedTokens).toBe(1315);
  expect(out.netTokens).toBe(315);
  expect(out.worthIt).toBe(true);
});

test("zero convergence is a pure loss — the W1 loose-schema case", () => {
  const out = continuationSavings({ costPerContinuation: 16700, authoringTokens: 1000, redundantUnits: 100, extraAgentsPerUnit: 2, convergence: 0 });
  expect(out.avoidedContinuations).toBe(0);
  expect(out.netTokens).toBe(-1000);
  expect(out.worthIt).toBe(false);
});

test("one avoided cache-inclusive continuation pays a modest grammar many times over", () => {
  const out = continuationSavings({ costPerContinuation: 16700, authoringTokens: 1000, redundantUnits: 1, extraAgentsPerUnit: 1, convergence: 1 });
  expect(out.netTokens).toBe(15700);
  expect(out.worthIt).toBe(true);
});

test("fractional convergence scales avoided continuations linearly", () => {
  const out = continuationSavings({ costPerContinuation: 1000, authoringTokens: 0, redundantUnits: 4, extraAgentsPerUnit: 3, convergence: 0.5 });
  expect(out.avoidedContinuations).toBe(6);
});