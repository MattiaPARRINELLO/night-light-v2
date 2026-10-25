/**
 * Garde-fou d'instrumentation : le rapport de mesure doit lire exactement
 * l'arbre de décision de `show.ts`.
 *
 * Depuis le chantier d'instrumentation, `plan_report` n'a plus aucune copie de
 * seuil ni de réservoir : il importe `familyBranchFor`, `moodBranchFor` et les
 * réservoirs. Ce test vérifie la conséquence observable — chaque branche
 * annoncée par le rapport redonne bien l'humeur et la famille du plan réel.
 */

import { describe, expect, test } from "bun:test";

import {
  buildShowPlan,
  FAMILY_BRANCHES,
  FAMILY_BRANCH_RESERVOIRS,
  MOOD_BRANCHES,
  MOOD_OF_BRANCH,
  moodBranchFor,
  moodFor,
  type Caractere,
} from "../../src/core/show";
import type { Analysis } from "../../src/types";
import { buildReport, FAMILY_BRANCHES as REPORT_FAMILY_BRANCHES, MOOD_BRANCHES as REPORT_MOOD_BRANCHES } from "../support/plan_report";

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  const beats = Array.from({ length: 480 }, (_, index) => index * 0.5);
  return {
    schema: 2,
    duration: 240,
    tempo: 120,
    beatPeriod: 0.5,
    beatCount: beats.length,
    beats,
    onsets: Array.from({ length: 240 }, (_, index) => index),
    energy: Array.from({ length: 241 }, (_, index) => [index, index < 60 ? 0.12 : index < 120 ? 0.5 : 0.85]),
    bass: Array.from({ length: 241 }, (_, index) => [index, 0.5]),
    mid: Array.from({ length: 241 }, (_, index) => [index, 0.5]),
    high: Array.from({ length: 241 }, (_, index) => [index, index < 120 ? 0.02 : 0.5]),
    sections: [
      { start: 0, end: 60, label: "calme", energy: 0.12, kind: "intro" },
      { start: 60, end: 120, label: "intense", energy: 0.5, kind: "couplet" },
      { start: 120, end: 200, label: "montee", energy: 0.8, kind: "pont" },
      { start: 200, end: 240, label: "descente", energy: 0.3, kind: "outro" },
    ],
    builds: [{ start: 116, end: 120, strength: 0.9 }],
    ...overrides,
  };
}

/** Grille de caractères pour comparer `moodFor` et l'arbre de branches. */
const GRID: Caractere[] = [];
for (const energy of [0.05, 0.2, 0.31, 0.45, 0.61, 0.75]) {
  for (const brightness of [0.0, 0.05, 0.12, 0.4]) {
    GRID.push({ energy, density: 1, brightness });
  }
}

describe("instrumentation du plan", () => {
  test("le rapport exporte les mêmes branches que show.ts", () => {
    expect([...REPORT_FAMILY_BRANCHES]).toEqual([...FAMILY_BRANCHES]);
    expect([...REPORT_MOOD_BRANCHES]).toEqual([...MOOD_BRANCHES]);
  });

  test("moodFor et moodBranchFor ne divergent pas sur une grille de caractères", () => {
    for (const caractere of GRID) {
      for (const label of ["intense", "calme", "montee"] as const) {
        const section = { start: 0, end: 1, label, energy: caractere.energy };
        expect(MOOD_OF_BRANCH[moodBranchFor("cycle", section, caractere, false, undefined, true)]).toBe(
          moodFor(caractere, label),
        );
      }
    }
  });

  test("chaque scène mesurée retrouve son humeur et son réservoir", () => {
    const report = buildReport([
      { name: "instrumentation", analysis: analysis(), source: "corpus" },
      { name: "instrumentation-réduite", analysis: analysis(), source: "corpus" },
    ]);
    expect(report.scenes.length).toBeGreaterThan(10);
    for (const scene of report.scenes) {
      // La branche rend l'humeur de base ; le plan peut l'avoir lissée.
      expect(MOOD_OF_BRANCH[scene.moodBranch]).toBe(scene.baseMood);
      // La famille vient du réservoir de la branche (sauf groupe/fond, compté
      // séparément comme « provenance non directe »).
      if (scene.provenance === "direct") {
        expect(FAMILY_BRANCH_RESERVOIRS[scene.familyBranch]).toContain(scene.family);
      }
      // Cohérence stricte humeur finale / réservoir.
      if (scene.mood === "calme") expect(scene.reservoir).not.toBe("non-calme");
      if (scene.mood !== "calme") expect(scene.reservoir).not.toBe("calme");
    }
    // L'hystérésis ne peut changer l'humeur que vers celle de la scène
    // précédente, et seulement pour un écart d'énergie inférieur à la marge.
    for (const track of report.tracks) {
      const rows = report.scenes.filter((scene) => scene.track === track.name);
      for (let index = 1; index < rows.length; index += 1) {
        const current = rows[index]!;
        const previous = rows[index - 1]!;
        if (current.mood === current.baseMood) continue;
        expect(current.mood).toBe(previous.mood);
        expect(Math.abs(current.energy - previous.energy)).toBeLessThan(0.051);
      }
    }
    // Et le plan lui-même reste cohérent avec le rapport.
    const plan = buildShowPlan(analysis(), false);
    expect(plan.scenes.map((scene) => scene.mood)).toEqual(
      report.scenes.filter((scene) => scene.track === "instrumentation").map((scene) => scene.mood),
    );
  });
});
