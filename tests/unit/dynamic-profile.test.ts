import { describe, expect, test } from "bun:test";

import {
  buildShowPlan,
  DYNAMIC_FAMILIES,
  familyBranchFor,
  resolveShowProfile,
} from "../../src/core/show";
import { dynamicStrobeAlpha, dynamicStrobeDivisions, flashAdmitted } from "../../src/core/render";
import { motifBordure } from "../../src/core/families/bordure";
import type { FrameState } from "../../src/core/families";
import { TrackView } from "../../src/core/view";
import type { Analysis, RenderSettings } from "../../src/types";

function points(value: number): [number, number][] {
  return [
    [0, value],
    [60, value],
  ];
}

/** Analyse énergique mais claire : le profil concert doit pouvoir la prendre. */
function energeticAnalysis(): Analysis {
  return {
    schema: 2,
    duration: 60,
    tempo: 128,
    beatCount: 128,
    beatPeriod: 60 / 128,
    beats: Array.from({ length: 129 }, (_, index) => index * (60 / 128)),
    onsets: Array.from({ length: 90 }, (_, index) => index * 0.66),
    energy: points(0.8),
    bass: points(0.75),
    mid: points(0.6),
    high: points(0.55),
    sections: [{ start: 0, end: 60, label: "intense", energy: 0.85 }],
    builds: [],
  };
}

describe("profil concert dynamique", () => {
  test("le réglage dynamic force le profil concert", () => {
    expect(resolveShowProfile(energeticAnalysis(), "dynamic")).toBe("dynamic");
  });

  test("la branche concert est prioritaire, même sur une scène calme", () => {
    const caractere = { energy: 0.2, density: 1, brightness: 0.1 };
    expect(familyBranchFor(caractere, false, "couplet", false, true, false, true)).toBe("concert");
  });

  test("le plan concert reste dans le réservoir de concert", () => {
    const plan = buildShowPlan(energeticAnalysis(), false, 7, { hard: "dynamic" });
    expect(plan.profile).toBe("dynamic");
    expect(plan.scenes.length).toBeGreaterThan(0);
    for (const scene of plan.scenes) {
      expect(DYNAMIC_FAMILIES).toContain(scene.family);
    }
  });

  test("le strobe concert part plus facilement que le hard", () => {
    const settings = { intensity: 1, flashes: 0.9, reduced: false, hard: "dynamic" } as RenderSettings;
    const frame = (overrides: Partial<FrameState> = {}) =>
      ({
        dynamic: true,
        reduced: false,
        energy: 0.6,
        beat: 1,
        bass: 0.7,
        beatPhase: 0,
        beatIndex: 0,
        t: 0,
        ...overrides,
      }) as unknown as FrameState;
    const divisions = dynamicStrobeDivisions(frame(), 0.5);
    expect(divisions).toBeGreaterThanOrEqual(2);
    expect(divisions).toBeLessThanOrEqual(6);
    // À 0,6 d'énergie, le hard serait encore muet ; le concert strobe déjà.
    expect(dynamicStrobeAlpha(frame(), settings, 0.5)).toBeGreaterThan(0);
    expect(dynamicStrobeAlpha(frame({ dynamic: false }), settings, 0.5)).toBe(0);
    expect(dynamicStrobeAlpha(frame({ reduced: true }), settings, 0.5)).toBe(0);
    expect(
      dynamicStrobeAlpha(frame(), { ...settings, flashes: 0 } as RenderSettings, 0.5),
    ).toBe(0);
    expect(dynamicStrobeAlpha(frame({ beat: 0, bass: 0 }), settings, 0.5)).toBe(0);
  });

  test("le profil concert admet les temps forts des passages énergiques", () => {
    const view = new TrackView(energeticAnalysis());
    let admitted = 0;
    for (let time = 0; time < 20; time += 0.05) {
      if (flashAdmitted(view, time, false, true)) admitted += 1;
    }
    expect(admitted).toBeGreaterThan(0);
  });

  test("la bordure LED strobe souvent en concert, sans être permanente", () => {
    const view = new TrackView(energeticAnalysis());
    const frame = (seed: number, role: string) =>
      ({
        dynamic: true,
        hard: false,
        reduced: false,
        energy: 0.8,
        beat: 1,
        bass: 0.8,
        beatIndex: 0,
        beatPhase: 0,
        seed,
        buildStrength: 0,
        scene: { role, index: 0 },
      }) as unknown as FrameState;
    const rate = (role: string, dynamic: boolean): number => {
      let strobes = 0;
      for (let seed = 0; seed < 200; seed += 1) {
        const current = frame(seed, role);
        if (motifBordure(dynamic ? current : { ...current, dynamic: false }, view) === "strobe") {
          strobes += 1;
        }
      }
      return strobes / 200;
    };
    const dropRate = rate("drop", true);
    expect(dropRate).toBeGreaterThan(0.1);
    expect(dropRate).toBeLessThan(0.25);
    expect(rate("refrain", true)).toBeGreaterThan(0.05);
    expect(rate("couplet", true)).toBeGreaterThan(0.03);
    // Le standard ne strobe pas sur ces blocs : le concert en ajoute vraiment.
    expect(rate("drop", false)).toBe(0);
    expect(rate("couplet", false)).toBe(0);
  });
});
