/**
 * Contrat d'analyse v3.1 — dramaturgie du plan.
 *
 * Vérifie les objectifs de la vague 3 sur les fixtures synthétiques :
 * branches réveillées, frontières de cycle minoritaires, refrains d'un même
 * groupe reconnaissables, silence sombre sans impact, bass-return consommé,
 * sections peu fiables ignorées, mode réduit contenu.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  BASS_RETURN_MERGE_BONUS,
  buildShowPlan,
  caractereAt,
  DROP_PONT_STRENGTH_THRESHOLD,
  FAMILY_BRANCH_RESERVOIRS,
  minHueStepEff,
  MOOD_BRANCHES,
  MOOD_OF_BRANCH,
  type FamilyId,
  type Scene,
} from "../../src/core/show";
import type { Analysis, Section } from "../../src/types";
import {
  allContractViolations,
  loadContractFixtures,
  type ContractFixture,
} from "../support/contract_fixtures";
import { buildReport, formatReport } from "../support/plan_report";
import { stableStringify } from "../support/plan_snapshot";
import { flashAlphaAt } from "../../src/core/render";
import { DEFAULT_SETTINGS } from "../../src/types";

const fixtures = loadContractFixtures();
const byName = (name: string): ContractFixture => {
  const fixture = fixtures.find((candidate) => candidate.name === name);
  if (fixture === undefined) throw new Error(`fixture absente : ${name}`);
  return fixture;
};

function sectionOf(analysis: Analysis, start: number): Section | undefined {
  return analysis.sections.find((section) => start >= section.start && start < section.end);
}

function circular(left: number, right: number): number {
  return Math.abs((((left - right) % 360) + 540) % 360 - 180);
}

function scenesWithRole(plan: ReturnType<typeof buildShowPlan>, role: string): Scene[] {
  return plan.scenes.filter((scene) => scene.role === role);
}

describe("contrat v3.1 — forme des fixtures", () => {
  test("au moins six fixtures et aucune violation du contrat", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
    expect(allContractViolations(fixtures)).toEqual([]);
  });

  test("les analyses restent des analyses v2 lisibles (champs existants intacts)", () => {
    for (const fixture of fixtures) {
      expect(fixture.analysis.schema).toBe(2);
      expect(fixture.analysis.meter === 3 || fixture.analysis.meter === 4).toBe(true);
      expect(fixture.analysis.sections.length).toBeGreaterThan(0);
      expect(fixture.analysis.beats.length).toBeGreaterThan(0);
      expect(fixture.analysis.energy.length).toBeGreaterThan(0);
    }
  });
});

describe("contrat v3.1 — couverture du plan", () => {
  for (const fixture of fixtures) {
    test(`scènes contiguës et triées : ${fixture.name}`, () => {
      const plan = buildShowPlan(fixture.analysis, false);
      expect(plan.scenes[0]?.start).toBeCloseTo(0, 3);
      for (let index = 1; index < plan.scenes.length; index += 1) {
        expect(plan.scenes[index]!.start).toBeCloseTo(plan.scenes[index - 1]!.end, 3);
        expect(plan.scenes[index]!.index).toBe(index);
      }
      expect(plan.scenes[plan.scenes.length - 1]!.end).toBeCloseTo(fixture.analysis.duration, 3);
    });
  }
});

describe("contrat v3.1 — branches dramaturgiques réveillées", () => {
  const plans = fixtures.map((fixture) => ({ fixture, plan: buildShowPlan(fixture.analysis, false) }));
  const roles = new Set(plans.flatMap(({ plan }) => plan.scenes.map((scene) => scene.role)));
  const moods = new Set(plans.flatMap(({ plan }) => plan.scenes.map((scene) => scene.mood)));
  const reasons = new Set(plans.flatMap(({ plan }) => plan.scenes.map((scene) => scene.reason)));

  test("rôles refrain et montée atteints", () => {
    expect(roles.has("refrain")).toBe(true);
    expect(roles.has("montee")).toBe(true);
  });

  test("humeur sombre atteinte", () => {
    expect(moods.has("sombre")).toBe(true);
  });

  test("raison section atteinte (les fixtures n'ont pas de section globale)", () => {
    expect(reasons.has("section")).toBe(true);
  });

  test("raison bass-return atteinte sans créer de drop", () => {
    expect(reasons.has("bass-return")).toBe(true);
    for (const { plan } of plans) {
      for (const scene of plan.scenes) {
        if (scene.reason === "bass-return") expect(scene.drop).toBeUndefined();
      }
    }
  });

  test("les branches d'humeur refrain / montée / silence sont vivantes", () => {
    expect(MOOD_BRANCHES).toContain("refrain-explosif");
    expect(MOOD_BRANCHES).toContain("montee-pulse");
    expect(MOOD_BRANCHES).toContain("silence-sombre");
    expect(MOOD_OF_BRANCH["refrain-explosif"]).toBe("explosif");
    expect(MOOD_OF_BRANCH["montee-pulse"]).toBe("pulse");
    expect(MOOD_OF_BRANCH["silence-sombre"]).toBe("sombre");
  });
});

describe("contrat v3.1 — frontières de cycle minoritaires", () => {
  test("sur les fixtures à sections fiables, cycle < 15 % des scènes", () => {
    const fiables = fixtures.filter((fixture) =>
      fixture.analysis.sections.some((section) => (section.confidence ?? 1) >= 0.5),
    );
    let total = 0;
    let cycles = 0;
    for (const fixture of fiables) {
      const plan = buildShowPlan(fixture.analysis, false);
      total += plan.scenes.length;
      cycles += plan.scenes.filter((scene) => scene.reason === "cycle").length;
    }
    const part = cycles / Math.max(total, 1);
    expect(part, `part cycle = ${(part * 100).toFixed(1)} % (${cycles}/${total})`).toBeLessThan(0.15);
  });
});

describe("contrat v3.1 — refrains d'un même groupe", () => {
  test("même famille de base, même teinte complémentaire, intensité croissante", () => {
    for (const fixture of fixtures) {
      const plan = buildShowPlan(fixture.analysis, false);
      const groupes = new Map<string, Scene[]>();
      for (const scene of scenesWithRole(plan, "refrain")) {
        const section = sectionOf(fixture.analysis, scene.start);
        const group = section?.group;
        if (group === undefined || group === "") continue;
        const list = groupes.get(group) ?? [];
        list.push(scene);
        groupes.set(group, list);
      }
      for (const [group, scenes] of groupes) {
        expect(new Set(scenes.map((scene) => scene.family)).size, `${fixture.name} groupe ${group}`).toBe(1);
        expect(new Set(scenes.map((scene) => scene.palette.hue)).size, `${fixture.name} groupe ${group}`).toBe(1);
        // Les refrains restent sur la complémentaire du morceau.
        for (const scene of scenes) {
          expect(circular(scene.palette.hue, plan.track.accent)).toBeLessThanOrEqual(plan.track.spread + 1e-6);
        }
        // Une moyenne par occurrence, strictement croissante.
        const parOccurrence = new Map<number, number[]>();
        for (const scene of scenes) {
          const section = sectionOf(fixture.analysis, scene.start);
          const occurrence = section?.occurrence ?? 0;
          const list = parOccurrence.get(occurrence) ?? [];
          list.push(scene.intensity);
          parOccurrence.set(occurrence, list);
        }
        const moyennes = [...parOccurrence.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, values]) => values.reduce((sum, value) => sum + value, 0) / values.length);
        if (moyennes.length >= 2) {
          for (let index = 1; index < moyennes.length; index += 1) {
            expect(
              moyennes[index]!,
              `${fixture.name} groupe ${group} : ${moyennes.join(" < ")}`,
            ).toBeGreaterThan(moyennes[index - 1]!);
          }
        }
      }
    }
  });
});

describe("contrat v3.1 — pont", () => {
  test("famille hors réservoir des refrains et teinte éloignée du dernier refrain", () => {
    const fixture = byName("refrain-pont");
    const plan = buildShowPlan(fixture.analysis, false);
    const ponts = scenesWithRole(plan, "montee").filter((scene) => {
      const section = sectionOf(fixture.analysis, scene.start);
      return section?.kind === "pont";
    });
    expect(ponts.length).toBeGreaterThan(0);
    const refrains = scenesWithRole(plan, "refrain");
    expect(refrains.length).toBeGreaterThan(0);
    const dernierRefrain = refrains[refrains.length - 1]!;
    for (const pont of ponts) {
      expect(FAMILY_BRANCH_RESERVOIRS.refrain).not.toContain(pont.family);
      expect(FAMILY_BRANCH_RESERVOIRS.pont).toContain(pont.family);
      expect(circular(pont.palette.hue, dernierRefrain.palette.hue)).toBeGreaterThanOrEqual(
        minHueStepEff(plan.track.spread),
      );
    }
  });
});

describe("contrat v3.1 — silence", () => {
  test("silence ≥ 1,5 s : humeur sombre, extinction progressive, aucun drop", () => {
    const fixture = byName("silence-milieu");
    const plan = buildShowPlan(fixture.analysis, false);
    for (const section of fixture.analysis.sections) {
      if (section.kind !== "silence") continue;
      const scenes = plan.scenes.filter((scene) => scene.start >= section.start && scene.end <= section.end);
      expect(scenes.length).toBeGreaterThan(0);
      for (const scene of scenes) {
        expect(scene.mood).toBe("sombre");
        expect(scene.drop).toBeUndefined();
        expect(scene.fadeOut).toBeGreaterThanOrEqual(1.5);
        expect(scene.intensity).toBeLessThanOrEqual(0.15);
      }
    }
  });

  test("aucun flash possible pendant le silence (énergie sous la porte de brillance)", () => {
    const fixture = byName("silence-milieu");
    const plan = buildShowPlan(fixture.analysis, false);
    for (const section of fixture.analysis.sections) {
      if (section.kind !== "silence") continue;
      const energie = caractereAt(fixture.analysis, section.start, section.end).energy;
      expect(energie).toBeLessThan(0.12);
      for (const scene of plan.scenes) {
        if (scene.start < section.start || scene.end > section.end) continue;
        // Pire cas : temps fort et basses à 1. La porte d'énergie du rendu
        // (`smoothstep(0.12, 0.4, énergie)`) doit annuler le flash.
        const alpha = flashAlphaAt(1, 1, 0, 0, energie, false, DEFAULT_SETTINGS);
        expect(alpha, `flash possible à ${scene.start.toFixed(2)} s`).toBe(0);
      }
    }
  });
});

describe("contrat v3.1 — bass-return", () => {
  test("frontière admise, espacement respecté, bonus de fusion < build", () => {
    expect(BASS_RETURN_MERGE_BONUS).toBeLessThan(1.25);
    expect(BASS_RETURN_MERGE_BONUS).toBeGreaterThan(0);
    const fixture = byName("rap-bass-return");
    const plan = buildShowPlan(fixture.analysis, false);
    const returns = plan.scenes.filter((scene) => scene.reason === "bass-return");
    expect(returns.length).toBeGreaterThan(0);
    expect(scenesWithRole(plan, "drop")).toHaveLength(0);
    const times = (fixture.analysis.events ?? []).map((event) => event.t).sort((a, b) => a - b);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(8);
    }
    expect(DROP_PONT_STRENGTH_THRESHOLD).toBeGreaterThan(0);
  });
});

describe("contrat v3.1 — sections peu fiables", () => {
  test("confidence < 0,5 : aucun rôle refrain/pont/silence, aucune humeur forcée", () => {
    const fixture = byName("confidence-faible");
    expect(fixture.analysis.sections.every((section) => (section.confidence ?? 1) < 0.5)).toBe(true);
    const plan = buildShowPlan(fixture.analysis, false);
    expect(scenesWithRole(plan, "refrain")).toHaveLength(0);
    expect(scenesWithRole(plan, "montee")).toHaveLength(0);
    expect(plan.scenes.some((scene) => scene.mood === "sombre")).toBe(false);
    expect(plan.scenes.some((scene) => scene.reason === "bass-return")).toBe(false);
  });
});

describe("contrat v3.1 — mode réduit", () => {
  const REDUCED = new Set<string>([
    "waves",
    "tunnel",
    "particles",
    "rings",
    "spiral",
    "pluie",
    "beams",
  ]);

  for (const fixture of fixtures) {
    test(`mêmes rôles, familles du réservoir réduit : ${fixture.name}`, () => {
      const normal = buildShowPlan(fixture.analysis, false);
      const reduced = buildShowPlan(fixture.analysis, true);
      expect(reduced.scenes.map((scene) => scene.role)).toEqual(normal.scenes.map((scene) => scene.role));
      for (const scene of reduced.scenes) {
        expect(REDUCED.has(scene.family), `${fixture.name} : ${scene.family}`).toBe(true);
        expect(scene.drop).toBeUndefined();
        expect(scene.backdrop).not.toBe("rings");
      }
    });
  }
});

describe("contrat v3.1 — métrique", () => {
  test("un 3/4 change la longueur du cycle de barres", () => {
    const waltz = byName("valse-3-4");
    const binary = byName("refrain-x3");
    const planWaltz = buildShowPlan(waltz.analysis, false);
    const planBinary = buildShowPlan(binary.analysis, false);
    const step = (plan: typeof planWaltz) =>
      (plan.barStarts[1] ?? 0) - (plan.barStarts[0] ?? 0);
    expect(step(planWaltz)).toBeCloseTo(waltz.analysis.beatPeriod * 12, 2);
    expect(step(planBinary)).toBeCloseTo(binary.analysis.beatPeriod * 16, 2);
  });
});

describe("contrat v3.1 — déterminisme", () => {
  test("le rapport des fixtures est identique octet pour octet et de même SHA-256", () => {
    const first = stableStringify(buildReport(fixtures));
    const second = stableStringify(buildReport(fixtures));
    expect(second).toBe(first);
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(sha(second)).toBe(sha(first));
    expect(formatReport(buildReport(fixtures))).toContain("=== Corpus ===");
  });

  test("les rôles et raisons attendus sont atteints sur les fixtures", () => {
    const report = buildReport(fixtures);
    const roles = new Set(Object.keys(report.distributions.roles));
    for (const role of ["intro", "couplet", "refrain", "montee", "finale"]) {
      expect(roles.has(role), `rôle mort : ${role}`).toBe(true);
    }
    const reasons = new Set(Object.keys(report.distributions.reasons));
    for (const reason of ["ouverture", "section", "bass-return", "finale"]) {
      expect(reasons.has(reason), `raison morte : ${reason}`).toBe(true);
    }
    // `drop` / `build` / `build-explosif` restent morts sur ces fixtures :
    // aucune n'a de montée. Ils restent vivants sur le corpus réel (vague 2).
    expect(report.distributions.roles.drop ?? 0).toBe(0);
    const moodBranches = new Set(Object.keys(report.distributions.moodBranches));
    for (const branch of ["refrain-explosif", "montee-pulse", "silence-sombre"]) {
      expect(moodBranches.has(branch), `branche d'humeur morte : ${branch}`).toBe(true);
    }
  });
});

// Garde de typage : les familles citées restent dans le registre.
const _familles: FamilyId[] = [...FAMILY_BRANCH_RESERVOIRS.pont];
void _familles;
