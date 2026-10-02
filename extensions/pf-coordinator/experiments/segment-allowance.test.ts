import { expect, test } from "bun:test";
import { forecastCollision, relativeFrequencies } from "./segment-allowance.ts";

test("relativeFrequencies normalizes counts and handles empty input", () => {
  expect(relativeFrequencies([4, 2, 2])).toEqual([0.5, 0.25, 0.25]);
  expect(relativeFrequencies([])).toEqual([]);
});

test("forecastCollision: one dominant type concentrates collision", () => {
  const f = forecastCollision([1], 10);
  expect(f.distinct).toBe(1);
  expect(f.collisionRate).toBeCloseTo(0.9);
  expect(f.coreTypes).toBe(1);
});

test("forecastCollision: uniform types collide little at low draw count", () => {
  const f = forecastCollision([0.5, 0.5], 2);
  expect(f.distinct).toBeCloseTo(1.5);
  expect(f.collisionRate).toBeCloseTo(0.25);
});

test("forecastCollision: collision grows toward the shared core as draws rise", () => {
  const freqs = [0.5, 0.25, 0.25];
  expect(forecastCollision(freqs, 100).collisionRate).toBeGreaterThan(forecastCollision(freqs, 2).collisionRate);
});