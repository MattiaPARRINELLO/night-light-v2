import { describe, expect, test } from "bun:test";

import {
  buildShowPlan,
  CALM_FAMILIES,
  detectShowProfile,
  familyBranchFor,
  HARD_BACKDROPS,
  HARD_FAMILIES,
  hardnessMetrics,
  resolveShowProfile,
  type ShowProfile,
} from "../../src/core/show";
import { flashAdmitted, hardStrobeAlpha, hardStrobeDivisions } from "../../src/core/render";
import { hardStrobeAllowsFull, hardStrobePhase } from "../../src/core/strobe";
import type { FrameState } from "../../src/core/families";
import { TrackView } from "../../src/core/view";
import type { Analysis, RenderSettings } from "../../src/types";

function points(value: number): [number, number][] {
  return [
    [0, value],
    [60, value],
  ];
}

/**
 * Une analyse « hard » : énergie soutenue, basses au maximum, aigus rares.
 * C'est le profil d'un mix trap/phonk, pas d'un morceau clair et équilibré.
 */
function hardAnalysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    schema: 2,
    duration: 60,
    tempo: 145,
    beatCount: 145,
    beatPeriod: 60 / 145,
    beats: Array.from({ length: 146 }, (_, index) => index * (60 / 145)),
    onsets: Array.from({ length: 60 }, (_, index) => index),
    energy: points(0.88),
    bass: points(0.96),
    mid: points(0.4),
    high: points(0.08),
    sections: [{ start: 0, end: 60, label: "intense", energy: 0.9 }],
    builds: [],
    ...overrides,
  };
}

/** Même énergie, mais un mix clair : ce n'est pas un morceau hard. */
function brightAnalysis(): Analysis {
  return hardAnalysis({ high: points(0.8), mid: points(0.7) });
}

function expectProfile(actual: ShowProfile, expected: ShowProfile): void {
  expect(actual).toBe(expected);
}

describe("profil hard", () => {
  test("détecte un mix sombre et chargé en basses", () => {
    const metrics = hardnessMetrics(hardAnalysis());
    expect(metrics.energy).toBeGreaterThan(0.7);
    expect(metrics.bassDominance).toBeGreaterThan(0.3);
    expectProfile(detectShowProfile(hardAnalysis()), "hard");
  });

  test("ne confond pas un morceau clair avec un morceau hard", () => {
    expectProfile(detectShowProfile(brightAnalysis()), "standard");
  });

  test("le réglage force ou coupe la détection", () => {
    expectProfile(resolveShowProfile(brightAnalysis(), "on"), "hard");
    expectProfile(resolveShowProfile(hardAnalysis(), "off"), "standard");
    expectProfile(resolveShowProfile(hardAnalysis(), "auto"), "hard");
  });

  test("le plan forcé en hard garde son vocabulaire de familles", () => {
    const plan = buildShowPlan(hardAnalysis(), false, 7, { hard: "on" });
    expect(plan.profile).toBe("hard");
    expect(HARD_BACKDROPS).toContain(plan.backdrop);
    expect(["sang-glace", "violet-acide", "braise-nuit", "magenta-arc"]).toContain(plan.track.name);
    for (const scene of plan.scenes) {
      // Les rôles de concert gardent la priorité (refrain, montée, impact) ;
      // les autres scènes puisent dans le réservoir hard.
      if (CALM_FAMILIES.includes(scene.family)) continue;
      if (scene.role === "refrain" || scene.role === "montee" || scene.role === "drop") continue;
      expect(HARD_FAMILIES).toContain(scene.family);
    }
    const fort = plan.scenes.find((scene) => scene.mood === "explosif");
    if (fort !== undefined) {
      expect(fort.palette.saturation).toBe(1);
      expect(fort.palette.lightness).toBeLessThanOrEqual(0.6);
    }
  });

  test("le mode auto n'active pas le hard sur un morceau clair", () => {
    const plan = buildShowPlan(brightAnalysis(), false, 3);
    expect(plan.profile).toBe("standard");
  });

  test("le plan hard est déterministe", () => {
    const first = buildShowPlan(hardAnalysis(), false, 11, { hard: "on" });
    const second = buildShowPlan(hardAnalysis(), false, 11, { hard: "on" });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("la branche hard ne prend jamais une scène calme", () => {
    const caractere = { energy: 0.9, density: 4, brightness: 0.1 };
    expect(familyBranchFor(caractere, false, "couplet", false, false, true)).toBe("hard");
    expect(familyBranchFor(caractere, false, "couplet", false, true, true)).toBe("calme");
    expect(familyBranchFor(caractere, false, "couplet", false, false, false)).not.toBe("hard");
  });

  test("le strobe hard reste rapide mais sous le papillotement continu", () => {
    const settings = { intensity: 1, flashes: 0.9, reduced: false, hard: "on" } as RenderSettings;
    const frame = (overrides: Partial<FrameState> = {}) =>
      ({
        hard: true,
        reduced: false,
        energy: 1,
        beat: 1,
        bass: 1,
        beatPhase: 0,
        beatIndex: 0,
        t: 0,
        ...overrides,
      }) as unknown as FrameState;
    const divisions = hardStrobeDivisions(frame(), 1);
    expect(divisions).toBe(12);
    // À 140 BPM, 12 éclats par temps valent ~28 Hz, pas 80.
    expect((divisions / (60 / 140))).toBeLessThan(30);
    expect(hardStrobeDivisions(frame({ energy: 0.6 }), 0)).toBeLessThan(divisions);
    expect(hardStrobeAlpha(frame(), settings, 1)).toBeGreaterThan(0.3);
    // Phase impaire à cette densité : l'écran est éteint.
    expect(hardStrobeAlpha(frame({ beatPhase: 0.3 }), settings, 1)).toBe(0);
    expect(hardStrobeAlpha(frame({ hard: false }), settings, 1)).toBe(0);
    expect(hardStrobeAlpha(frame({ reduced: true }), settings, 1)).toBe(0);
    expect(
      hardStrobeAlpha(frame(), { ...settings, flashes: 0 } as RenderSettings, 1),
    ).toBe(0);
    // Sans basse ni kick, pas de strobe : l'écran revient à la scène.
    expect(hardStrobeAlpha(frame({ beat: 0, bass: 0 }), settings, 1)).toBe(0);
  });

  test("le cycle hard alterne plein, barres seules, puis reprise", () => {
    const settings = { intensity: 1, flashes: 0.9, reduced: false, hard: "on" } as RenderSettings;
    const frame = (beatIndex: number) =>
      ({
        hard: true,
        reduced: false,
        energy: 1,
        beat: 1,
        bass: 1,
        beatPhase: 0,
        beatIndex,
      }) as unknown as FrameState;
    expect([0, 1, 2, 3].map((beat) => hardStrobePhase(frame(beat)))).toEqual([
      "plein",
      "plein",
      "plein",
      "plein",
    ]);
    expect([4, 5].map((beat) => hardStrobePhase(frame(beat)))).toEqual(["barres", "barres"]);
    expect([6, 7].map((beat) => hardStrobePhase(frame(beat)))).toEqual(["reprise", "reprise"]);
    expect([0, 4, 6].map((beat) => hardStrobeAllowsFull(frame(beat)))).toEqual([true, false, true]);
    // Le plein écran se tait pendant le creux, la bordure prend le relais.
    expect(hardStrobeAlpha(frame(4), settings, 1)).toBe(0);
    expect(hardStrobeAlpha(frame(6), settings, 1)).toBeGreaterThan(0);
  });

  test("le profil hard admet un flash sur chaque temps fort", () => {
    const view = new TrackView(hardAnalysis());
    let normal = 0;
    let hard = 0;
    for (let time = 0; time < 60; time += 0.05) {
      if (flashAdmitted(view, time)) normal += 1;
      if (flashAdmitted(view, time, true)) hard += 1;
    }
    expect(hard).toBeGreaterThan(normal);
    expect(hard).toBeGreaterThan(0);
  });
});
