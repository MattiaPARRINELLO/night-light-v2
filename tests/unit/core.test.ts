import { describe, expect, test } from "bun:test";

import {
  clamp,
  clamp01,
  formatTime,
  hash01,
  hashString,
  lowerBound,
  mix,
  sampleAt,
  smoothstep,
} from "../../src/core/series";
import { TrackView } from "../../src/core/view";
import type { Analysis, Point } from "../../src/types";

function points(entries: Array<[number, number]>): Point[] {
  return entries;
}

describe("series", () => {
  test("lowerBound trouve le dernier point avant ou à t", () => {
    const curve = points([
      [0, 0],
      [1, 0.5],
      [2, 1],
    ]);
    expect(lowerBound(curve, -1)).toBe(-1);
    expect(lowerBound(curve, 0)).toBe(0);
    expect(lowerBound(curve, 0.5)).toBe(0);
    expect(lowerBound(curve, 1.5)).toBe(1);
    expect(lowerBound(curve, 99)).toBe(2);
  });

  test("sampleAt interpole linéairement", () => {
    const curve = points([
      [0, 0],
      [1, 0.5],
      [2, 1],
    ]);
    expect(sampleAt(curve, 0.5)).toBeCloseTo(0.25, 6);
    expect(sampleAt(curve, 1.5)).toBeCloseTo(0.75, 6);
    expect(sampleAt(curve, 5)).toBeCloseTo(1, 6);
    expect(sampleAt(curve, -5)).toBeCloseTo(0, 6);
  });

  test("sampleAt gère une courbe vide", () => {
    expect(sampleAt([], 3)).toBe(0);
  });

  test("clamp01, mix et smoothstep", () => {
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(7)).toBe(1);
    expect(clamp(Number.NaN, 2, 5)).toBe(2);
    expect(clamp(Number.POSITIVE_INFINITY, 0, 1)).toBe(0);
    expect(mix(0, 10, 0.25)).toBe(2.5);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 6);
    expect(smoothstep(2, 1, 0)).toBe(0);
  });

  test("hash est déterministe et borné", () => {
    expect(hash01(42)).toBe(hash01(42));
    expect(hashString("abc")).toBe(hashString("abc"));
    for (const seed of [0, 1, 99, 12345]) {
      const value = hash01(seed);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test("formatTime", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(65.4)).toBe("1:05");
    expect(formatTime(-3)).toBe("0:00");
    expect(formatTime(Number.NaN)).toBe("0:00");
  });
});

describe("analyse factice", () => {
  function fakeAnalysis(overrides: Partial<Analysis> = {}): Analysis {
    return {
      schema: 2,
      duration: 30,
      tempo: 120,
      beatCount: 0,
      beatPeriod: 0.5,
      beats: [],
      onsets: [],
      energy: [
        [0, 0.1],
        [10, 0.4],
        [20, 0.8],
        [30, 0.2],
      ],
      bass: [
        [0, 0.2],
        [30, 0.9],
      ],
      mid: [
        [0, 0.5],
        [30, 0.5],
      ],
      high: [
        [0, 0.4],
        [30, 0.1],
      ],
      sections: [
        { start: 0, end: 15, label: "calme", energy: 0.25 },
        { start: 15, end: 30, label: "intense", energy: 0.75 },
      ],
      builds: [{ start: 8, end: 15, strength: 0.8 }],
      ...overrides,
    };
  }

  test("TrackView lit les courbes et les sections", () => {
    const view = new TrackView(fakeAnalysis());
    expect(view.energyAt(5)).toBeCloseTo(0.25, 6);
    expect(view.sectionAt(5).label).toBe("calme");
    expect(view.sectionAt(20).label).toBe("intense");
    expect(view.energyTrend(20, 10)).toBeGreaterThan(0);
  });

  test("buildProgress progresse de 0 à 1 dans la montée", () => {
    const view = new TrackView(fakeAnalysis());
    expect(view.buildProgress(8)).toBe(0);
    expect(view.buildProgress(11.5)).toBeCloseTo(0.5, 6);
    expect(view.buildProgress(16)).toBe(0);
    expect(view.buildAt(10)?.strength).toBe(0.8);
  });

  test("beatPulse décroît depuis le dernier temps fort", () => {
    const view = new TrackView(fakeAnalysis({ beats: [2, 4, 6, 8] }));
    expect(view.beatPulse(2.02, 0.5)).toBeGreaterThan(0.8);
    expect(view.beatPulse(2.4, 0.5)).toBeLessThan(0.05);
    expect(view.beatsIn(3, 7)).toEqual([4, 6]);
    expect(view.beatsIn(10, 20)).toEqual([]);
  });

  test("beatPhase couvre 0..1 entre deux temps", () => {
    const view = new TrackView(fakeAnalysis({ beats: [0, 1, 2, 3, 4] }));
    expect(view.beatPhase(0.5)).toBeCloseTo(0.5, 6);
    expect(view.beatPhase(1.25)).toBeCloseTo(0.25, 6);
  });

  test("brightnessAt reflète la part d'aigus", () => {
    const view = new TrackView(fakeAnalysis());
    expect(view.brightnessAt(0)).toBeGreaterThan(view.brightnessAt(30));
  });

  test("onsetsIn renvoie la fenêtre demandée (borne gauche exclue)", () => {
    const view = new TrackView(fakeAnalysis({ onsets: [1, 2, 3, 4, 5] }));
    expect(view.onsetsIn(2, 4)).toEqual([3, 4]);
    expect(view.onsetsIn(1, 5)).toEqual([2, 3, 4, 5]);
    expect(view.onsetsIn(9, 10)).toEqual([]);
  });
});
