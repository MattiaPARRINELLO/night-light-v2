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
import type { Analysis } from "../../src/types";

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
});
