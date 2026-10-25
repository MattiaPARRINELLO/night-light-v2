#!/usr/bin/env bun
/**
 * Photo de référence « avant » : corpus synthétique vs corpus réel.
 *
 *   uv run python tools/real_corpus.py      # une fois (télécharge + analyse)
 *   bun tools/baseline-report.ts            # écrit les deux rapports
 *
 * Produit, de façon déterministe :
 * - `tools/baseline-report.md`   : lecture humaine, synthétique et réel côte à côte ;
 * - `tools/baseline-report.json` : version machine (clés triées, 6 décimales).
 *
 * Aucun horodatage de génération n'entre dans les fichiers : deux exécutions
 * donnent le même SHA-256. Le corpus réel n'entre jamais dans les snapshots.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { FAMILY_LABELS, MOOD_LABELS, SCENE_REASON_LABELS, SCENE_ROLE_LABELS } from "../src/core/show";
import type { PlanTrack } from "../tests/support/plan_corpus";
import { loadCorpusAnalyses, loadRealCorpus, type RealPlanTrack } from "../tests/support/plan_corpus";
import { buildReport, stats, type PlanMeasureReport, type Stats } from "../tests/support/plan_report";
import { stableStringify } from "../tests/support/plan_snapshot";
import { sampleDrops, type DropSaturation } from "../tests/support/drop_saturation";
import { createHeadlessRenderer } from "../tests/support/headless_render";

const OUT_DIR = join(import.meta.dir);
const ENERGY_GAP_LOW = 0.55;
const ENERGY_GAP_HIGH = 0.68;

export interface CorpusSummary {
  tracks: number;
  scenes: number;
  drops: number;
  energy: Stats;
  density: Stats;
  brightness: Stats;
  energyGap: { low: number; high: number; below: number; inside: number; above: number; shareInside: number };
  cycleShare: number;
  explosiveShare: number;
  distinctFamilies: number;
  usedFamilies: string[];
  deadFamilies: string[];
  deadRoles: string[];
  deadMoods: string[];
  deadReasons: string[];
  deadFamilyBranches: string[];
  deadMoodBranches: string[];
  dropsPerTrack: Array<{ name: string; profile: string | null; drops: number }>;
  zeroDropTracks: Array<{ name: string; profile: string | null }>;
}

export interface DropSaturationRow {
  track: string;
  profile: string | null;
  start: number;
  end: number;
  samples: number;
  mean: number;
  p90: number;
  max: number;
  maxAt: number;
}

export interface SaturationSummary {
  drops: number;
  samples: number;
  mean: number;
  p90: number;
  max: number;
  maxTrack: string | null;
  maxAt: number | null;
  perDrop: DropSaturationRow[];
}

export interface BaselineReport {
  version: number;
  method: {
    synthetic: string;
    real: string;
    energyGap: [number, number];
    saturation: { fps: number; luminance: number; saturation: number; width: number; height: number };
  };
  synthetic: CorpusSummary;
  real: CorpusSummary;
  saturationReal: SaturationSummary;
}

function summarize(report: PlanMeasureReport, profiles: Map<string, string>): CorpusSummary {
  const scenes = report.scenes;
  const total = scenes.length || 1;
  const energies = scenes.map((scene) => scene.energy);
  const drops = report.tracks.reduce((sum, track) => sum + track.drops, 0);
  const usedFamilies = Object.keys(report.distributions.families).sort();
  const dropsPerTrack = report.tracks.map((track) => ({
    name: track.name,
    profile: profiles.get(track.name) ?? null,
    drops: track.drops,
  }));

  return {
    tracks: report.tracks.length,
    scenes: scenes.length,
    drops,
    energy: report.characters.energy,
    density: report.characters.density,
    brightness: report.characters.brightness,
    energyGap: {
      low: ENERGY_GAP_LOW,
      high: ENERGY_GAP_HIGH,
      below: energies.filter((value) => value <= ENERGY_GAP_LOW).length,
      inside: energies.filter((value) => value > ENERGY_GAP_LOW && value < ENERGY_GAP_HIGH).length,
      above: energies.filter((value) => value >= ENERGY_GAP_HIGH).length,
      shareInside: energies.filter((value) => value > ENERGY_GAP_LOW && value < ENERGY_GAP_HIGH).length / total,
    },
    cycleShare: (report.distributions.reasons.cycle ?? 0) / total,
    explosiveShare: (report.distributions.moods.explosif ?? 0) / total,
    distinctFamilies: usedFamilies.length,
    usedFamilies,
    deadFamilies: [...report.deadBranches.families].sort(),
    deadRoles: [...report.deadBranches.roles].sort(),
    deadMoods: [...report.deadBranches.moods].sort(),
    deadReasons: [...report.deadBranches.reasons].sort(),
    deadFamilyBranches: [...report.deadBranches.familyBranches].sort(),
    deadMoodBranches: [...report.deadBranches.moodBranches].sort(),
    dropsPerTrack,
    zeroDropTracks: dropsPerTrack
      .filter((track) => track.drops === 0)
      .map((track) => ({ name: track.name, profile: track.profile })),
  };
}

function saturationRow(track: RealPlanTrack, drop: DropSaturation): DropSaturationRow {
  let maxIndex = 0;
  for (let index = 1; index < drop.ratios.length; index += 1) {
    if ((drop.ratios[index] ?? 0) > (drop.ratios[maxIndex] ?? 0)) maxIndex = index;
  }
  return {
    track: track.titre,
    profile: track.profile,
    start: drop.window.start,
    end: drop.window.end,
    samples: drop.ratios.length,
    mean: drop.stats.mean,
    p90: drop.stats.p90,
    max: drop.ratios[maxIndex] ?? 0,
    maxAt: drop.times[maxIndex] ?? drop.window.start,
  };
}

async function measureSaturation(tracks: ReadonlyArray<RealPlanTrack>): Promise<SaturationSummary> {
  const renderer = await createHeadlessRenderer();
  const perDrop: DropSaturationRow[] = [];
  const allRatios: number[] = [];
  try {
    for (const track of tracks) {
      const drops = await sampleDrops(renderer, track, { width: 320, height: 180, dpr: 1, quality: 1 });
      for (const drop of drops) {
        perDrop.push(saturationRow(track, drop));
        allRatios.push(...drop.ratios);
      }
    }
  } finally {
    await renderer.close();
  }
  const distribution = stats(allRatios);
  const maxRow = perDrop.reduce<DropSaturationRow | null>(
    (best, row) => (best === null || row.max > best.max ? row : best),
    null,
  );
  return {
    drops: perDrop.length,
    samples: allRatios.length,
    mean: distribution.mean,
    p90: distribution.p90,
    max: maxRow?.max ?? 0,
    maxTrack: maxRow?.track ?? null,
    maxAt: maxRow?.maxAt ?? null,
    perDrop,
  };
}

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)} %`;
}

function num(value: number, digits = 3): string {
  return value.toFixed(digits);
}

function statsLine(label: string, value: Stats): string {
  return (
    `| ${label} | ${num(value.min)} | ${num(value.p10)} | ${num(value.median)} | ` +
    `${num(value.p75)} | ${num(value.p90)} | ${num(value.max)} | ${num(value.mean)} |`
  );
}

function deadList(label: string, values: ReadonlyArray<string>, labels?: Record<string, string>): string {
  if (values.length === 0) return `- **${label}** : aucune`;
  const rendered = values.map((value) => (labels?.[value] ? `${value} (${labels[value]})` : value));
  return `- **${label}** (${values.length}) : ${rendered.join(", ")}`;
}

export function markdown(report: BaselineReport): string {
  const rows = report.synthetic;
  const real = report.real;
  const sat = report.saturationReal;
  const lines: string[] = [];
  lines.push("# Baseline — plan de spectacle, synthétique vs réel");
  lines.push("");
  lines.push(
    "Photo de référence générée par `bun tools/baseline-report.ts`. " +
      "Aucun horodatage : le fichier est reproductible au SHA-256 près.",
  );
  lines.push("");
  lines.push("## Corpus");
  lines.push("");
  lines.push(
    `- **Synthétique** : ${rows.tracks} pistes, ${rows.scenes} scènes (make_corpus.py).`,
  );
  lines.push(
    `- **Réel** : ${real.tracks} pistes, ${real.scenes} scènes (manifeste \`tests/support/real_corpus.json\`).`,
  );
  lines.push("");
  lines.push("## 1. Distributions des caractères par scène");
  lines.push("");
  lines.push("| caractère | min | p10 | médiane | p75 | p90 | max | moyenne |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  const characterRows: Array<[string, string, Stats]> = [
    ["énergie", "synthétique", rows.energy],
    ["énergie", "réel", real.energy],
    ["densité", "synthétique", rows.density],
    ["densité", "réel", real.density],
    ["brillance", "synthétique", rows.brightness],
    ["brillance", "réel", real.brightness],
  ];
  for (const [name, corpus, value] of characterRows) {
    lines.push(statsLine(`${name} (${corpus})`, value));
  }
  lines.push("");
  lines.push(
    `**Bimodalité de l'énergie** — scènes dans ]${ENERGY_GAP_LOW} ; ${ENERGY_GAP_HIGH}[ : ` +
      `synthétique ${rows.energyGap.inside}/${rows.scenes} (${pct(rows.energyGap.shareInside)}), ` +
      `réel ${real.energyGap.inside}/${real.scenes} (${pct(real.energyGap.shareInside)}).`,
  );
  lines.push(
    `Répartition : synthétique ${rows.energyGap.below} ≤ ${ENERGY_GAP_LOW} / ` +
      `${rows.energyGap.above} ≥ ${ENERGY_GAP_HIGH} ; réel ${real.energyGap.below} / ${real.energyGap.above}.`,
  );
  lines.push("");
  lines.push("## 2. Frontières et humeurs");
  lines.push("");
  lines.push("| mesure | synthétique | réel |");
  lines.push("| --- | --- | --- |");
  lines.push(`| frontières \`cycle\` | ${pct(rows.cycleShare)} | ${pct(real.cycleShare)} |`);
  lines.push(`| humeur \`explosif\` | ${pct(rows.explosiveShare)} | ${pct(real.explosiveShare)} |`);
  lines.push(`| familles distinctes | ${rows.distinctFamilies} | ${real.distinctFamilies} |`);
  lines.push("");
  lines.push("### Familles mortes");
  lines.push("");
  lines.push(deadList("Synthétique", rows.deadFamilies, FAMILY_LABELS));
  lines.push(deadList("Réel", real.deadFamilies, FAMILY_LABELS));
  lines.push("");
  lines.push("### Autres branches mortes");
  lines.push("");
  lines.push(deadList("Rôles (synthétique)", rows.deadRoles, SCENE_ROLE_LABELS));
  lines.push(deadList("Rôles (réel)", real.deadRoles, SCENE_ROLE_LABELS));
  lines.push(deadList("Humeurs (synthétique)", rows.deadMoods, MOOD_LABELS));
  lines.push(deadList("Humeurs (réel)", real.deadMoods, MOOD_LABELS));
  lines.push(deadList("Raisons (synthétique)", rows.deadReasons, SCENE_REASON_LABELS));
  lines.push(deadList("Raisons (réel)", real.deadReasons, SCENE_REASON_LABELS));
  lines.push(deadList("familyFor (synthétique)", rows.deadFamilyBranches));
  lines.push(deadList("familyFor (réel)", real.deadFamilyBranches));
  lines.push(deadList("moodFor (synthétique)", rows.deadMoodBranches));
  lines.push(deadList("moodFor (réel)", real.deadMoodBranches));
  lines.push("");
  lines.push("## 3. Drops par morceau");
  lines.push("");
  lines.push("| corpus | morceau | profil | drops |");
  lines.push("| --- | --- | --- | --- |");
  for (const track of rows.dropsPerTrack) {
    lines.push(`| synthétique | ${track.name} | — | ${track.drops} |`);
  }
  for (const track of real.dropsPerTrack) {
    lines.push(`| réel | ${track.name} | ${track.profile ?? "—"} | ${track.drops} |`);
  }
  lines.push("");
  lines.push("### Morceaux réels sans aucun drop");
  lines.push("");
  if (real.zeroDropTracks.length === 0) lines.push("Aucun : toutes les pistes réelles déclenchent au moins un impact.");
  else {
    for (const track of real.zeroDropTracks) {
      lines.push(`- ${track.name} — ${track.profile ?? "profil inconnu"}`);
    }
  }
  lines.push("");
  lines.push("## 4. Saturation des drops (corpus réel)");
  lines.push("");
  lines.push(
    `Échantillonnage 10 Hz, 320×180, luminance > ${report.method.saturation.luminance} et ` +
      `saturation < ${report.method.saturation.saturation}. ` +
      `**${sat.drops} drops, ${sat.samples} échantillons** ; moyenne ${pct(sat.mean, 2)}, ` +
      `p90 ${pct(sat.p90, 2)}, max ${pct(sat.max, 2)}` +
      `${sat.maxTrack === null ? "" : ` (${sat.maxTrack} à ${sat.maxAt?.toFixed(2)} s)`}.`,
  );
  lines.push("");
  lines.push("| morceau | début | fin | n | moyenne | p90 | max | max à |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const drop of sat.perDrop) {
    lines.push(
      `| ${drop.track} | ${drop.start.toFixed(2)} s | ${drop.end.toFixed(2)} s | ${drop.samples} | ` +
        `${pct(drop.mean, 2)} | ${pct(drop.p90, 2)} | ${pct(drop.max, 2)} | ${drop.maxAt.toFixed(2)} s |`,
    );
  }
  lines.push("");
  lines.push("## Notes de méthode");
  lines.push("");
  lines.push(
    "- Le corpus synthétique est celui des snapshots (`tests/support/make_corpus.py`) ; " +
      "le corpus réel ne sert qu'à ce rapport et n'entre dans aucun test de CI.",
  );
  lines.push(
    "- Les snapshots de plans restent limités au synthétique : reproductibles sans réseau ni jeton.",
  );
  lines.push("- `p90` de la saturation est calculé sur tous les échantillons de drops confondus.",);
  return `${lines.join("\n")}\n`;
}

function manifestProfiles(tracks: ReadonlyArray<RealPlanTrack>): Map<string, string> {
  return new Map(tracks.map((track) => [track.titre, track.profile]));
}

async function main(): Promise<number> {
  const syntheticTracks = loadCorpusAnalyses();
  const realTracks = loadRealCorpus();
  if (realTracks.length === 0) throw new Error("corpus réel vide");

  // Garde-fou : les durées du manifeste sont mesurées, pas déclaratives.
  for (const track of realTracks) {
    const duration = track.analysis.duration;
    if (Math.abs(duration - track.expectedDuration) > 1) {
      throw new Error(
        `durée incohérente pour ${track.titre} : manifeste ${track.expectedDuration}, analyse ${duration}`,
      );
    }
  }

  const syntheticReport = buildReport(syntheticTracks as PlanTrack[]);
  const realReport = buildReport(realTracks as PlanTrack[]);
  const saturation = await measureSaturation(realTracks);

  const report: BaselineReport = {
    version: 1,
    method: {
      synthetic: "tests/support/make_corpus.py (6 pistes de 60 s)",
      real: "tests/support/real_corpus.json (10 morceaux Deezer, analyses hors git)",
      energyGap: [ENERGY_GAP_LOW, ENERGY_GAP_HIGH],
      saturation: { fps: 10, luminance: 0.92, saturation: 0.15, width: 320, height: 180 },
    },
    synthetic: summarize(syntheticReport, new Map()),
    real: summarize(realReport, manifestProfiles(realTracks)),
    saturationReal: saturation,
  };

  const jsonPath = join(OUT_DIR, "baseline-report.json");
  const markdownPath = join(OUT_DIR, "baseline-report.md");
  const json = stableStringify(report, 6);
  writeFileSync(jsonPath, json, "utf8");
  writeFileSync(markdownPath, markdown(report), "utf8");

  const sha = createHash("sha256").update(json).digest("hex");
  console.log(`baseline : ${markdownPath}`);
  console.log(`baseline : ${jsonPath}`);
  console.log(`sha256  : ${sha}`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`baseline-report : ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
