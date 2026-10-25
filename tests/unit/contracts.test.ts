/**
 * Contrats croisés plan ↔ rendu (tâche D6).
 *
 * A modifie le plan, B le rendu, et ils ne se parlent pas. Ces tests vérifient
 * ce qui doit rester vrai ENTRE les deux : budget de teinte, champs du plan
 * réellement consommés, familles et branches atteignables avec les analyses
 * réelles (jamais fabriquées à la main).
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  buildShowPlan,
  caractereAt,
  FAMILY_LABELS,
  sceneAt,
  type FamilyId,
} from "../../src/core/show";
import { sceneHue, HUE_DRIFT_PER_SEC } from "../../src/core/render";
import { createTrackView } from "../../src/core/view";
import type { Analysis, Point } from "../../src/types";
import { corpusAnalyses } from "../support/corpus";

const tracks = corpusAnalyses();

/** `src/core/render.ts:71` — respiration de la teinte autour de celle de la scène. */
const HUE_BREATH_DEG = 14;
/** `src/core/render.ts:83` — écart maximal à la teinte de scène, impacts compris. */
const HUE_IMPACT_LIMIT = 32;

function circular(left: number, right: number): number {
  return Math.abs((((left - right) % 360) + 540) % 360 - 180);
}

/** Décale tous les points d'un multiple de la durée d'origine (simulation 10 min). */
function tiled(points: Point[], duration: number, total: number): Point[] {
  const out: Point[] = [];
  for (const [time, value] of points) {
    for (let offset = 0; offset < total; offset += duration) out.push([time + offset, value]);
  }
  return out;
}

/** Étend une analyse réelle à 10 minutes, par répétition déterministe. */
function extendToTenMinutes(analysis: Analysis): Analysis {
  const total = 600;
  const repetitions = Math.ceil(total / analysis.duration);
  const shift = (times: number[]): number[] => {
    const out: number[] = [];
    for (let index = 0; index < repetitions; index += 1) {
      for (const time of times) {
        const value = time + index * analysis.duration;
        if (value <= total) out.push(value);
      }
    }
    return out;
  };
  return {
    ...analysis,
    duration: total,
    beats: shift(analysis.beats),
    onsets: shift(analysis.onsets),
    energy: tiled(analysis.energy, analysis.duration, total),
    bass: tiled(analysis.bass, analysis.duration, total),
    mid: tiled(analysis.mid, analysis.duration, total),
    high: tiled(analysis.high, analysis.duration, total),
    builds: analysis.builds.flatMap((build) =>
      Array.from({ length: repetitions }, (_, index) => ({
        start: build.start + index * analysis.duration,
        end: build.end + index * analysis.duration,
        strength: build.strength,
      })).filter((build) => build.end <= total),
    ),
    sections: [{ start: 0, end: total, label: "intense", energy: 0.7 }],
  };
}

describe("X1 — budget de teinte plan + rendu", () => {
  // BUG D'ORIGINE : `sceneHue` ajoutait une dérive linéaire (`0,4 °/s × t`),
  // soit 240° sur 10 min. La PR #29 la remplace par une sinusoïde bornée et un
  // clamp vers l'ancre : le test n'est plus marqué `failing`.
  test("la teinte rendue reste dans ±(spread + marge) de l'ancre sur 10 min simulées", () => {
    const margin = HUE_IMPACT_LIMIT + HUE_BREATH_DEG;
    const violations: string[] = [];
    let worst = { track: "", excursion: 0, at: 0, budget: 0 };
    for (const { name, analysis } of tracks) {
      const extended = extendToTenMinutes(analysis);
      const plan = buildShowPlan(extended, false);
      const view = createTrackView(extended);
      const budget = plan.track.spread + margin;
      for (let t = 0; t < extended.duration; t += 1 / 30) {
        const scene = sceneAt(plan, t);
        const hue = sceneHue(scene, t, view.buildIntensity(t), 0, false);
        const anchor = Math.min(
          circular(hue, plan.track.hue),
          circular(hue, plan.track.accent),
        );
        if (anchor > budget) {
          if (anchor > worst.excursion) worst = { track: name, excursion: anchor, at: t, budget };
          if (!violations.includes(name)) violations.push(name);
        }
      }
    }
    expect(
      violations,
      `pire cas : ${worst.track} à ${worst.at.toFixed(1)} s, écart ${worst.excursion.toFixed(1)}° ` +
        `pour un budget de ${worst.budget.toFixed(1)}° (HUE_DRIFT_PER_SEC=${HUE_DRIFT_PER_SEC})`,
    ).toEqual([]);
  });
});

describe("X2 — tout champ de Scene est consommé par le rendu", () => {
  const ROOT = resolve(import.meta.dir, "../..");
  const sources: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) sources.push(readFileSync(path, "utf8"));
    }
  };
  walk(join(ROOT, "src/core"));

  const FIELDS = [
    "index",
    "start",
    "end",
    "family",
    "variant",
    "backdrop",
    "palette",
    "intensity",
    "fadeIn",
    "fadeOut",
    "mood",
    "role",
    "reason",
  ];

  test.failing(
    "aucun champ du plan n'est mort (backdrop et reason sont les cas connus)",
    () => {
      // `sceneWeight` (show.ts:732-739) consomme fadeIn/fadeOut : on cherche donc
      // aussi dans show.ts, mais le rendu l'appelle bien (render.ts:477).
      const unused = FIELDS.filter((field) => {
        const pattern = new RegExp(`scene\\.${field}\\b`);
        return !sources.some((source) => pattern.test(source));
      });
      expect(unused, `champs de Scene jamais lus par le rendu : ${unused.join(", ")}`).toEqual([]);
    },
  );
});

describe("X3 — toute famille du registre est atteignable", () => {
  test.failing("au moins une scène choisit chaque famille déclarée", () => {
    const used = new Set<FamilyId>();
    for (const { analysis } of tracks) {
      for (const scene of buildShowPlan(analysis, false).scenes) used.add(scene.family);
    }
    const never = (Object.keys(FAMILY_LABELS) as FamilyId[]).filter((family) => !used.has(family));
    expect(
      never,
      `${never.length}/${Object.keys(FAMILY_LABELS).length} familles jamais choisies sur le corpus : ${never.join(", ")}`,
    ).toEqual([]);
  });
});

describe("X4 — branches atteignables avec les analyses réelles", () => {
  test.failing("aucune branche morte de moodFor / roleFor / familyFor", () => {
    const moods = new Set<string>();
    const roles = new Set<string>();
    const roleBranches = new Set<string>();
    const moodBranches = new Set<string>();
    const familyBranches = new Set<string>();

    for (const { analysis } of tracks) {
      const plan = buildShowPlan(analysis, false);
      for (const scene of plan.scenes) {
        const caractere = caractereAt(analysis, scene.start, scene.end);
        const { energy, density, brightness } = caractere;
        const section =
          analysis.sections.length > 1
            ? (analysis.sections.find((item) => scene.start >= item.start && scene.start < item.end) ??
              analysis.sections[analysis.sections.length - 1])
            : null;
        const label = section?.label ?? "intense";

        moods.add(scene.mood);
        roles.add(scene.role);

        // Rejoue l'ordre exact des conditions de moodFor (show.ts:420-430).
        if (scene.reason === "build") moodBranches.add("build → explosif");
        else if (label === "silence") moodBranches.add("silence → sombre");
        else if (label === "montee") moodBranches.add("montée → pulse");
        else if (energy > 0.62) moodBranches.add("énergie > 0,62 → explosif");
        else if (energy < 0.3) moodBranches.add("énergie < 0,3 → calme");
        else if (brightness > 0.68) moodBranches.add("brillance > 0,68 → aérien");
        else moodBranches.add("défaut → pulse");

        // roleFor (show.ts:379-390).
        if (scene.reason === "build") roleBranches.add("build → drop");
        else if (section?.kind === "intro") roleBranches.add("kind intro → intro");
        else if (section?.kind === "refrain") roleBranches.add("kind refrain → refrain");
        else if (section?.kind === "couplet") roleBranches.add("kind couplet → couplet");
        else if (section?.kind === "outro") roleBranches.add("kind outro → finale");
        else if (section?.kind === "pont") roleBranches.add("kind pont → montée");
        else if (scene.reason === "ouverture" || scene.index === 0) roleBranches.add("ouverture → intro");
        else if (section?.label === "montee") roleBranches.add("label montée → montée");
        else if (section?.label === "descente" || section?.label === "silence") roleBranches.add("label descente/silence → finale");
        else roleBranches.add("défaut → couplet");

        // familyFor (show.ts:340-369), hors mode réduit.
        if (scene.role === "refrain") familyBranches.add("rôle refrain");
        else if (scene.role === "montee") familyBranches.add("rôle montée");
        else if (energy < 0.22) familyBranches.add("énergie < 0,22 (calmes)");
        else if (brightness > 0.62) familyBranches.add("brillance > 0,62 (saturée)");
        else if (density > 2.2) familyBranches.add("densité > 2,2 (rythmiques)");
        else if (energy > 0.6) familyBranches.add("énergie > 0,6 (énergiques)");
        else familyBranches.add("défaut (toutes)");
      }
    }

    const deadMood = [
      "silence → sombre",
      "montée → pulse",
      "défaut → pulse",
    ].filter((branch) => !moodBranches.has(branch));
    const deadRole = [
      "kind intro → intro",
      "kind refrain → refrain",
      "kind couplet → couplet",
      "kind outro → finale",
      "kind pont → montée",
      "label montée → montée",
      "label descente/silence → finale",
    ].filter((branch) => !roleBranches.has(branch));
    const deadFamily = [
      "rôle refrain",
      "rôle montée",
      "énergie < 0,22 (calmes)",
      "brillance > 0,62 (saturée)",
      "densité > 2,2 (rythmiques)",
      "énergie > 0,6 (énergiques)",
      "défaut (toutes)",
    ].filter((branch) => !familyBranches.has(branch));

    expect(
      { deadMood, deadRole, deadFamily },
      `branches mortes — moods : ${deadMood.join(", ") || "aucune"} ; ` +
        `rôles : ${deadRole.join(", ") || "aucune"} ; ` +
        `familles : ${deadFamily.join(", ") || "aucune"} ` +
        `(humeurs observées : ${[...moods].join(", ")} ; rôles : ${[...roles].join(", ")})`,
    ).toEqual({ deadMood: [], deadRole: [], deadFamily: [] });
  });
});
