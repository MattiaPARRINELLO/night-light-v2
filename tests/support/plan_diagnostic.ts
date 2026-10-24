/**
 * Diagnostic du plan de spectacle sur le corpus de mesure.
 *
 * Lit les analyses générées par `make_corpus.py` et imprime, pour chaque scène,
 * la famille, l'humeur, le rôle, la raison, la teinte et la branche de décision
 * de `familyFor`, puis les histogrammes qui servent de preuve avant/après aux
 * correctifs du plan.
 *
 * Usage :
 *   bun tests/support/plan_diagnostic.ts [corpus] [--json]
 *
 * `corpus` vaut `/tmp/night-light-plan-corpus` par défaut.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BRIGHTNESS_THRESHOLD,
  buildShowPlan,
  CALM_ENERGY_THRESHOLD,
  caractereAt,
  DENSITY_THRESHOLD,
  ENERGY_THRESHOLD,
  type Scene,
  type ShowPlan,
} from "../../src/core/show";
import type { Analysis } from "../../src/types";

const DEFAULT_CORPUS = "/tmp/night-light-plan-corpus";

type Branch =
  | "reduit-calme"
  | "reduit-rythmique"
  | "refrain"
  | "montee"
  | "drop"
  | "calme"
  | "brillance"
  | "densite"
  | "energie"
  | "general";

interface CorpusTrack {
  name: string;
  analysis: Analysis;
}

function loadCorpus(root: string): CorpusTrack[] {
  const files = readdirSync(root)
    .filter((file) => file.endsWith(".json") && file !== "manifest.json")
    .sort();
  return files.map((file) => {
    const analysis = JSON.parse(readFileSync(join(root, file), "utf8")) as Analysis;
    return { name: file.replace(/\.json$/, ""), analysis };
  });
}

/**
 * Branche de décision de `familyFor`, recalculée ici pour que le diagnostic
 * montre la cause du choix, pas seulement son résultat.
 */
function branchOf(scene: Scene, analysis: Analysis, reduced = false): Branch {
  if (reduced) {
    return scene.mood === "calme" ? "reduit-calme" : "reduit-rythmique";
  }
  if (scene.role === "refrain") return "refrain";
  if (scene.role === "montee") return "montee";
  if (scene.role === "drop") return "drop";
  const caracter = caractereAt(analysis, scene.start, scene.end);
  if (caracter.energy < CALM_ENERGY_THRESHOLD) return "calme";
  if (caracter.brightness > BRIGHTNESS_THRESHOLD) return "brillance";
  if (caracter.density > DENSITY_THRESHOLD) return "densite";
  if (caracter.energy > ENERGY_THRESHOLD) return "energie";
  return "general";
}

function histogram(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const total = values.length || 1;
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([value, count]) => `${value} ${count} (${((count / total) * 100).toFixed(1)} %)`)
    .join(" · ");
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

function hueGap(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function diagnose(track: CorpusTrack): { plan: ShowPlan; branches: Branch[] } {
  const plan = buildShowPlan(track.analysis, false);
  const branches = plan.scenes.map((scene) => branchOf(scene, track.analysis));
  return { plan, branches };
}

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const root = args.find((arg) => !arg.startsWith("--")) ?? DEFAULT_CORPUS;
  const corpus = loadCorpus(root);

  const summary = {
    tracks: [] as Array<Record<string, unknown>>,
    families: [] as string[],
    moods: [] as string[],
    roles: [] as string[],
    reasons: [] as string[],
    branches: [] as string[],
    spans: [] as number[],
    hueGaps: [] as number[],
    hueOutOfSpread: 0,
    scenes: 0,
    drops: [] as Array<Record<string, unknown>>,
  };

  for (const track of corpus) {
    const { plan, branches } = diagnose(track);
    summary.scenes += plan.scenes.length;
    const trackBranches = { track: track.name, scenes: plan.scenes.length, branches: {} as Record<string, number> };
    for (let index = 0; index < plan.scenes.length; index += 1) {
      const scene = plan.scenes[index]!;
      const branch = branches[index]!;
      trackBranches.branches[branch] = (trackBranches.branches[branch] ?? 0) + 1;
      summary.families.push(scene.family);
      summary.moods.push(scene.mood);
      summary.roles.push(scene.role);
      summary.reasons.push(scene.reason);
      summary.branches.push(branch);
      summary.spans.push(scene.end - scene.start);
      const ecart = hueGap(scene.palette.hue, plan.track.hue);
      const ecartAccent = hueGap(scene.palette.hue, plan.track.accent);
      if (Math.min(ecart, ecartAccent) > plan.track.spread) summary.hueOutOfSpread += 1;
      if (index > 0) {
        const previous = plan.scenes[index - 1]!;
        summary.hueGaps.push(hueGap(scene.palette.hue, previous.palette.hue));
      }
      const signature = scene.drop === undefined
        ? "—"
        : `${scene.drop.lyres}/${scene.drop.barres}/${scene.drop.blinders}/${scene.drop.hue}`;
      if (scene.role === "drop") {
        summary.drops.push({
          track: track.name,
          start: scene.start,
          family: scene.family,
          mood: scene.mood,
          reason: scene.reason,
          hue: Math.round(scene.palette.hue),
          signature,
        });
      }
      if (!asJson) {
        console.log(
          `${track.name.padEnd(11)} #${String(scene.index).padStart(2)} ` +
            `${scene.start.toFixed(2).padStart(6)}→${scene.end.toFixed(2).padStart(6)} ` +
            `${scene.family.padEnd(16)} ${scene.mood.padEnd(9)} ${scene.role.padEnd(8)} ` +
            `${scene.reason.padEnd(9)} hue ${scene.palette.hue.toFixed(0).padStart(3)} ${branch}` +
            `${scene.role === "drop" ? ` [${signature}]` : ""}`,
        );
      }
    }
    summary.tracks.push(trackBranches);
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ...summary,
          histogram: {
            families: histogram(summary.families),
            moods: histogram(summary.moods),
            roles: histogram(summary.roles),
            reasons: histogram(summary.reasons),
            branches: histogram(summary.branches),
            spans: `min ${Math.min(...summary.spans).toFixed(2)} · ` +
              `médiane ${percentile(summary.spans, 0.5).toFixed(2)} · ` +
              `p90 ${percentile(summary.spans, 0.9).toFixed(2)} · ` +
              `max ${Math.max(...summary.spans).toFixed(2)}`,
            hueGaps: `min ${Math.min(...summary.hueGaps).toFixed(1)} · ` +
              `médiane ${percentile(summary.hueGaps, 0.5).toFixed(1)} · ` +
              `p10 ${percentile(summary.hueGaps, 0.1).toFixed(1)}`,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("\n=== Histogrammes ===");
  console.log(`branches : ${histogram(summary.branches)}`);
  console.log(`familles : ${histogram(summary.families)}`);
  console.log(`humeurs  : ${histogram(summary.moods)}`);
  console.log(`rôles    : ${histogram(summary.roles)}`);
  console.log(`raisons  : ${histogram(summary.reasons)}`);
  console.log(
    `durées   : min ${Math.min(...summary.spans).toFixed(2)} · ` +
      `médiane ${percentile(summary.spans, 0.5).toFixed(2)} · ` +
      `p90 ${percentile(summary.spans, 0.9).toFixed(2)} · ` +
      `max ${Math.max(...summary.spans).toFixed(2)}`,
  );
  console.log(
    `teintes  : écart voisin min ${Math.min(...summary.hueGaps).toFixed(1)} · ` +
      `médiane ${percentile(summary.hueGaps, 0.5).toFixed(1)} · ` +
      `p10 ${percentile(summary.hueGaps, 0.1).toFixed(1)} · ` +
      `hors spread ${summary.hueOutOfSpread}/${summary.scenes}`,
  );
  console.log(`\n${summary.drops.length} drops :`);
  for (const drop of summary.drops) console.log(JSON.stringify(drop));
}

main();
