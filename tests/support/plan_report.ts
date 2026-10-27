/**
 * Mesure du plan de spectacle sur un corpus : distributions, branches mortes,
 * incohérences humeur/réservoir, et diff entre deux versions.
 *
 * Ce module ne modifie **aucun** comportement du produit. Il recalcule le
 * caractère de chaque scène et la branche de décision qui a produit sa famille.
 *
 * Il n'y a **aucune recopie** de l'arbre de décision : `familyBranchFor`,
 * `moodBranchFor`, les seuils et les réservoirs sont importés de
 * `src/core/show.ts`, qui les exporte pour l'instrumentation. Une évolution de
 * `show.ts` se répercute donc mécaniquement sur les mesures.
 */

import {
  buildShowPlan,
  caractereAt,
  FAMILY_BRANCHES,
  FAMILY_BRANCH_RESERVOIRS,
  FAMILY_LABELS,
  familyBranchFor,
  groupKeyOf,
  hasStructuredAnalysis,
  isReliableSection,
  MOOD_BRANCHES,
  MOOD_LABELS,
  MOOD_OF_BRANCH,
  moodBranchFor,
  moodThresholdsFor,
  SCENE_REASON_LABELS,
  SCENE_ROLE_LABELS,
  type FamilyBranch,
  type FamilyId,
  type Mood,
  type MoodBranch,
  type MoodThresholds,
  type SceneReason,
  type SceneRole,
} from "../../src/core/show";
import type { Analysis, Section } from "../../src/types";
import type { PlanTrack } from "./plan_corpus";

// --- Branches de décision ---------------------------------------------------

export { FAMILY_BRANCHES, MOOD_BRANCHES };
export type { FamilyBranch, MoodBranch };

/** Réservoir associé à une branche de `familyFor`. */
const RESERVOIR = FAMILY_BRANCH_RESERVOIRS;

export type ReservoirKind = "calme" | "non-calme" | "mixte" | "concert";

/** Nature du réservoir d'une branche, pour l'audit humeur/réservoir. */
export function reservoirKind(branch: FamilyBranch): ReservoirKind {
  if (branch === "calme" || branch === "reduit-calme") return "calme";
  if (branch === "drop" || branch === "refrain" || branch === "montee" || branch === "pont") {
    return "concert";
  }
  if (branch === "general" || branch === "reduit-rythmique") return "mixte";
  return "non-calme";
}

function sectionAt(analysis: Analysis, t: number): Section | null {
  for (const section of analysis.sections) {
    if (t >= section.start && t < section.end) return section;
  }
  const last = analysis.sections[analysis.sections.length - 1];
  return last !== undefined && t >= last.end ? last : null;
}

function localSectionAt(analysis: Analysis, start: number): Section | null {
  const section = sectionAt(analysis, start);
  if (section === null) return null;
  const span = section.end - section.start;
  const global = span >= analysis.duration * 0.95 && section.start <= analysis.duration * 0.05;
  return global ? null : section;
}

/** Branche de `familyFor` telle qu'elle serait prise pour cette scène. */
export function familyBranchOf(
  role: SceneRole,
  caractere: { energy: number; density: number; brightness: number },
  reduced: boolean,
  calm?: boolean,
  pont = false,
): FamilyBranch {
  return familyBranchFor(caractere, reduced, role, !reduced && role === "drop", calm, pont);
}

/** Branche de `moodFor`, overrides du site d'appel compris. */
export function moodBranchOf(
  reason: SceneReason,
  section: Section | null,
  caractere: { energy: number; brightness: number },
  reduced: boolean,
  thresholds?: MoodThresholds,
  dramaturgy = false,
): MoodBranch {
  return moodBranchFor(reason, section, { ...caractere, density: 0 }, reduced, thresholds, dramaturgy);
}

// --- Statistiques -----------------------------------------------------------

export interface Stats {
  count: number;
  min: number;
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  max: number;
  mean: number;
}

/** Percentiles par interpolation linéaire (documenté, reproductible). */
export function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * ratio;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const a = sorted[low] ?? 0;
  const b = sorted[high] ?? a;
  return a + (b - a) * (position - low);
}

export function stats(values: readonly number[]): Stats {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    min: values.length > 0 ? Math.min(...values) : 0,
    p10: percentile(values, 0.1),
    p25: percentile(values, 0.25),
    median: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p90: percentile(values, 0.9),
    max: values.length > 0 ? Math.max(...values) : 0,
    mean: values.length > 0 ? total / values.length : 0,
  };
}

// --- Rapport ----------------------------------------------------------------

export interface SceneMeasure {
  track: string;
  index: number;
  start: number;
  end: number;
  reason: SceneReason;
  role: SceneRole;
  mood: Mood;
  /** Humeur avant le lissage d'hystérésis (celle que décrit `moodBranch`). */
  baseMood: Mood;
  family: FamilyId;
  variant: FamilyId;
  backdrop: FamilyId;
  hue: number;
  intensity: number;
  drop: string | null;
  energy: number;
  density: number;
  brightness: number;
  familyBranch: FamilyBranch;
  moodBranch: MoodBranch;
  reservoir: ReservoirKind;
  /** `direct` quand la famille appartient au réservoir calculé. */
  provenance: "direct" | "groupe-ou-fond" | "fond";
  grouped: boolean;
}

export interface TrackMeasure {
  name: string;
  source: "corpus" | "real" | "fixture";
  duration: number;
  seed: number;
  scenes: number;
  drops: number;
  /** Durée des scènes : min / médiane / p90, en secondes. */
  sceneSpans: Stats;
  sceneCounts: Record<string, number>;
}

export interface Incoherence {
  track: string;
  index: number;
  start: number;
  end: number;
  mood: Mood;
  family: FamilyId;
  familyBranch: FamilyBranch;
  reservoir: ReservoirKind;
  detail: string;
}

export interface SceneDistributions {
  scenes: number;
  roles: Record<string, number>;
  moods: Record<string, number>;
  families: Record<string, number>;
  reasons: Record<string, number>;
  familyBranches: Record<string, number>;
  moodBranches: Record<string, number>;
  reservoirs: Record<string, number>;
  sceneSpans: Stats;
}

export interface PlanMeasureReport {
  tracks: TrackMeasure[];
  scenes: SceneMeasure[];
  distributions: SceneDistributions & {
    dropsPerTrack: Record<string, number>;
  };
  /**
   * Mêmes distributions, scènes de drop exclues.
   *
   * Les drops actuels sont majoritairement des faux positifs : l'humeur se
   * calibre sur cette colonne, pas sur « toutes scènes ».
   */
  withoutDrops: SceneDistributions;
  characters: {
    energy: Stats;
    density: Stats;
    brightness: Stats;
  };
  charactersWithoutDrops: {
    energy: Stats;
    density: Stats;
    brightness: Stats;
  };
  deadBranches: {
    roles: SceneRole[];
    moods: Mood[];
    families: FamilyId[];
    reasons: SceneReason[];
    familyBranches: FamilyBranch[];
    moodBranches: MoodBranch[];
  };
  incoherences: {
    calmMoodNonCalmReservoir: Incoherence[];
    nonCalmMoodCalmReservoir: Incoherence[];
    /** Branches mixtes : ni calmes ni franchement rythmées, non comptées. */
    mixedReservoir: Incoherence[];
    /** Famille hors du réservoir calculé (groupe mémorisé ou fond substitué). */
    unknownProvenance: Incoherence[];
  };
  reduced: {
    scenes: number;
    distributions: {
      roles: Record<string, number>;
      moods: Record<string, number>;
      families: Record<string, number>;
      reasons: Record<string, number>;
      familyBranches: Record<string, number>;
      moodBranches: Record<string, number>;
    };
  };
}

function countBy<T extends string>(values: readonly T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function familyProvenance(
  family: FamilyId,
  branch: FamilyBranch,
  grouped: boolean,
): SceneMeasure["provenance"] {
  if (RESERVOIR[branch].includes(family)) return "direct";
  if (grouped) return "groupe-ou-fond";
  return "fond";
}

function measurePlan(track: PlanTrack, reduced: boolean): SceneMeasure[] {
  const plan = buildShowPlan(track.analysis, reduced);
  const dramaturgy = hasStructuredAnalysis(track.analysis);
  const measured = plan.scenes.map((scene) => ({
    scene,
    section: localSectionAt(track.analysis, scene.start),
    caractere: caractereAt(track.analysis, scene.start, scene.end),
  }));
  // Mêmes seuils que la production : la distribution d'énergie des scènes du
  // morceau, dans le même mode (normal ou réduit).
  const thresholds = moodThresholdsFor(measured.map((entry) => entry.caractere.energy));
  return measured.map(({ scene, section, caractere }) => {
    // La famille suit l'humeur finale du plan : une scène lissée en « calme »
    // reste dans un réservoir calme, donc l'audit humeur/réservoir ne ment pas.
    const pont =
      !reduced && scene.role === "montee" && isReliableSection(section) && section?.kind === "pont";
    const familyBranch = familyBranchOf(
      scene.role,
      caractere,
      reduced,
      scene.mood === "calme" || scene.mood === "sombre",
      pont,
    );
    const moodBranch = moodBranchOf(
      scene.reason,
      section,
      caractere,
      reduced,
      thresholds,
      dramaturgy,
    );
    const grouped = groupKeyOf(section) !== "";
    return {
      track: track.name,
      index: scene.index,
      start: scene.start,
      end: scene.end,
      reason: scene.reason,
      role: scene.role,
      mood: scene.mood,
      baseMood: MOOD_OF_BRANCH[moodBranch],
      family: scene.family,
      variant: scene.variant,
      backdrop: scene.backdrop,
      hue: scene.palette.hue,
      intensity: scene.intensity,
      drop:
        scene.drop === undefined
          ? null
          : `${scene.drop.lyres}/${scene.drop.barres}/${scene.drop.blinders}/${scene.drop.hue}`,
      energy: caractere.energy,
      density: caractere.density,
      brightness: caractere.brightness,
      familyBranch,
      moodBranch,
      reservoir: reservoirKind(familyBranch),
      provenance: familyProvenance(scene.family, familyBranch, grouped),
      grouped,
    };
  });
}

function deadOf<T extends string>(all: readonly T[], reached: ReadonlySet<string>): T[] {
  return all.filter((value) => !reached.has(value));
}

function distributionsOf(rows: readonly SceneMeasure[]): SceneDistributions {
  return {
    scenes: rows.length,
    roles: countBy(rows.map((scene) => scene.role)),
    moods: countBy(rows.map((scene) => scene.mood)),
    families: countBy(rows.map((scene) => scene.family)),
    reasons: countBy(rows.map((scene) => scene.reason)),
    familyBranches: countBy(rows.map((scene) => scene.familyBranch)),
    moodBranches: countBy(rows.map((scene) => scene.moodBranch)),
    reservoirs: countBy(rows.map((scene) => scene.reservoir)),
    sceneSpans: stats(rows.map((scene) => scene.end - scene.start)),
  };
}

function charactersOf(rows: readonly SceneMeasure[]): PlanMeasureReport["characters"] {
  return {
    energy: stats(rows.map((scene) => scene.energy)),
    density: stats(rows.map((scene) => scene.density)),
    brightness: stats(rows.map((scene) => scene.brightness)),
  };
}

export function buildReport(tracks: ReadonlyArray<PlanTrack>): PlanMeasureReport {
  const scenes: SceneMeasure[] = [];
  const trackMeasures: TrackMeasure[] = [];
  const reducedScenes: SceneMeasure[] = [];

  for (const track of tracks) {
    const measured = measurePlan(track, false);
    scenes.push(...measured);
    const plan = buildShowPlan(track.analysis, false);
    trackMeasures.push({
      name: track.name,
      source: track.source,
      duration: plan.duration,
      seed: plan.seed,
      scenes: measured.length,
      drops: measured.filter((scene) => scene.role === "drop").length,
      sceneSpans: stats(measured.map((scene) => scene.end - scene.start)),
      sceneCounts: countBy(measured.map((scene) => String(scene.index))),
    });
    reducedScenes.push(...measurePlan(track, true));
  }

  const allScenes = [...scenes, ...reducedScenes];
  const reachedFamilyBranches = new Set(allScenes.map((scene) => scene.familyBranch));
  const reachedMoodBranches = new Set(allScenes.map((scene) => scene.moodBranch));
  const reachedRoles = new Set(allScenes.map((scene) => scene.role));
  const reachedMoods = new Set(allScenes.map((scene) => scene.mood));
  const reachedFamilies = new Set(allScenes.map((scene) => scene.family));
  const reachedReasons = new Set(allScenes.map((scene) => scene.reason));

  const incoherences: PlanMeasureReport["incoherences"] = {
    calmMoodNonCalmReservoir: [],
    nonCalmMoodCalmReservoir: [],
    mixedReservoir: [],
    unknownProvenance: [],
  };
  for (const scene of scenes) {
    const row: Incoherence = {
      track: scene.track,
      index: scene.index,
      start: scene.start,
      end: scene.end,
      mood: scene.mood,
      family: scene.family,
      familyBranch: scene.familyBranch,
      reservoir: scene.reservoir,
      detail: `${scene.mood} / ${scene.familyBranch} → ${scene.family}`,
    };
    if (scene.provenance !== "direct") {
      incoherences.unknownProvenance.push(row);
      continue;
    }
    if (scene.mood === "calme" && scene.reservoir === "non-calme") {
      incoherences.calmMoodNonCalmReservoir.push(row);
    } else if (scene.mood !== "calme" && scene.reservoir === "calme") {
      incoherences.nonCalmMoodCalmReservoir.push(row);
    } else if (scene.reservoir === "mixte") {
      incoherences.mixedReservoir.push(row);
    }
  }

  const scenesReduced = reducedScenes;
  const scenesWithoutDrops = scenes.filter((scene) => scene.role !== "drop");

  return {
    tracks: trackMeasures,
    scenes,
    distributions: {
      ...distributionsOf(scenes),
      dropsPerTrack: Object.fromEntries(trackMeasures.map((track) => [track.name, track.drops])),
    },
    withoutDrops: distributionsOf(scenesWithoutDrops),
    characters: charactersOf(scenes),
    charactersWithoutDrops: charactersOf(scenesWithoutDrops),
    deadBranches: {
      roles: deadOf(Object.keys(SCENE_ROLE_LABELS) as SceneRole[], reachedRoles),
      moods: deadOf(Object.keys(MOOD_LABELS) as Mood[], reachedMoods),
      families: deadOf(Object.keys(FAMILY_LABELS) as FamilyId[], reachedFamilies),
      reasons: deadOf(Object.keys(SCENE_REASON_LABELS) as SceneReason[], reachedReasons),
      familyBranches: deadOf([...FAMILY_BRANCHES], reachedFamilyBranches),
      moodBranches: deadOf([...MOOD_BRANCHES], reachedMoodBranches),
    },
    incoherences,
    reduced: {
      scenes: scenesReduced.length,
      distributions: {
        roles: countBy(scenesReduced.map((scene) => scene.role)),
        moods: countBy(scenesReduced.map((scene) => scene.mood)),
        families: countBy(scenesReduced.map((scene) => scene.family)),
        reasons: countBy(scenesReduced.map((scene) => scene.reason)),
        familyBranches: countBy(scenesReduced.map((scene) => scene.familyBranch)),
        moodBranches: countBy(scenesReduced.map((scene) => scene.moodBranch)),
      },
    },
  };
}

// --- Rendu texte ------------------------------------------------------------

function formatStats(value: Stats): string {
  return (
    `n=${value.count} · min ${value.min.toFixed(2)} · p10 ${value.p10.toFixed(2)} · ` +
    `p25 ${value.p25.toFixed(2)} · médiane ${value.median.toFixed(2)} · ` +
    `p75 ${value.p75.toFixed(2)} · p90 ${value.p90.toFixed(2)} · max ${value.max.toFixed(2)}`
  );
}

function formatCounts(counts: Record<string, number>, total: number): string {
  const denominator = total || 1;
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, count]) => `${key} ${count} (${((count / denominator) * 100).toFixed(1)} %)`)
    .join(" · ");
}

function formatList<T extends string>(values: readonly T[]): string {
  return values.length === 0 ? "aucune" : values.join(", ");
}

export function formatReport(report: PlanMeasureReport): string {
  const lines: string[] = [];
  const total = report.scenes.length;
  lines.push("=== Corpus ===");
  lines.push("piste        scènes  drops  durée   scènes min / médiane / p90");
  for (const track of report.tracks) {
    lines.push(
      `${track.name.padEnd(12)} ${String(track.scenes).padStart(6)} ` +
        `${String(track.drops).padStart(6)} ${track.duration.toFixed(1).padStart(6)} s  ` +
        `${track.sceneSpans.min.toFixed(2)} / ${track.sceneSpans.median.toFixed(2)} / ` +
        `${track.sceneSpans.p90.toFixed(2)} s`,
    );
  }
  lines.push(`\n=== Distributions (plan normal, n=${total}) ===`);
  lines.push(`rôles           : ${formatCounts(report.distributions.roles, total)}`);
  lines.push(`humeurs         : ${formatCounts(report.distributions.moods, total)}`);
  lines.push(`familles        : ${formatCounts(report.distributions.families, total)}`);
  lines.push(`raisons         : ${formatCounts(report.distributions.reasons, total)}`);
  lines.push(`branches famille: ${formatCounts(report.distributions.familyBranches, total)}`);
  lines.push(`branches humeur : ${formatCounts(report.distributions.moodBranches, total)}`);
  lines.push(`réservoirs      : ${formatCounts(report.distributions.reservoirs, total)}`);
  lines.push(`durées de scène : ${formatStats(report.distributions.sceneSpans)}`);
  lines.push(
    `drops/morceau   : ${Object.entries(report.distributions.dropsPerTrack)
      .map(([name, count]) => `${name} ${count}`)
      .join(" · ")}`,
  );

  const sansDrops = report.withoutDrops;
  lines.push(`\n=== Hors scènes de drop (n=${sansDrops.scenes}) ===`);
  lines.push(`humeurs         : ${formatCounts(sansDrops.moods, sansDrops.scenes)}`);
  lines.push(`familles        : ${formatCounts(sansDrops.families, sansDrops.scenes)}`);
  lines.push(`raisons         : ${formatCounts(sansDrops.reasons, sansDrops.scenes)}`);
  lines.push(`branches famille: ${formatCounts(sansDrops.familyBranches, sansDrops.scenes)}`);
  lines.push(`branches humeur : ${formatCounts(sansDrops.moodBranches, sansDrops.scenes)}`);
  lines.push(`durées de scène : ${formatStats(sansDrops.sceneSpans)}`);

  lines.push("\n=== Caractères mesurés par scène ===");
  lines.push(`énergie   : ${formatStats(report.characters.energy)}`);
  lines.push(`densité   : ${formatStats(report.characters.density)}`);
  lines.push(`brillance : ${formatStats(report.characters.brightness)}`);
  lines.push("\n=== Caractères hors scènes de drop ===");
  lines.push(`énergie   : ${formatStats(report.charactersWithoutDrops.energy)}`);
  lines.push(`densité   : ${formatStats(report.charactersWithoutDrops.density)}`);
  lines.push(`brillance : ${formatStats(report.charactersWithoutDrops.brightness)}`);

  lines.push("\n=== Branches mortes (plan normal + réduit) ===");
  lines.push(`rôles           : ${formatList(report.deadBranches.roles)}`);
  lines.push(`humeurs         : ${formatList(report.deadBranches.moods)}`);
  lines.push(`familles        : ${formatList(report.deadBranches.families)}`);
  lines.push(`raisons         : ${formatList(report.deadBranches.reasons)}`);
  lines.push(`familyFor       : ${formatList(report.deadBranches.familyBranches)}`);
  lines.push(`moodFor         : ${formatList(report.deadBranches.moodBranches)}`);

  const incoherences = report.incoherences;
  lines.push("\n=== Incohérences humeur / réservoir ===");
  const dump = (label: string, rows: Incoherence[]) => {
    lines.push(`${label} : ${rows.length}`);
    for (const row of rows) {
      lines.push(
        `  - ${row.track} #${row.index} ${row.start.toFixed(2)}→${row.end.toFixed(2)} ` +
          `${row.detail} (réservoir ${row.reservoir})`,
      );
    }
  };
  dump("humeur calme, réservoir non calme", incoherences.calmMoodNonCalmReservoir);
  dump("humeur non calme, réservoir calme", incoherences.nonCalmMoodCalmReservoir);
  dump("réservoir mixte (information)", incoherences.mixedReservoir);
  dump("provenance non directe (groupe/fond)", incoherences.unknownProvenance);

  lines.push(`\n=== Mode réduit (n=${report.reduced.scenes}) ===`);
  lines.push(`rôles           : ${formatCounts(report.reduced.distributions.roles, report.reduced.scenes)}`);
  lines.push(`humeurs         : ${formatCounts(report.reduced.distributions.moods, report.reduced.scenes)}`);
  lines.push(`familles        : ${formatCounts(report.reduced.distributions.families, report.reduced.scenes)}`);
  lines.push(
    `branches famille: ${formatCounts(report.reduced.distributions.familyBranches, report.reduced.scenes)}`,
  );
  return lines.join("\n");
}

// --- Diff -------------------------------------------------------------------

function diffCounts(
  label: string,
  before: Record<string, number>,
  after: Record<string, number>,
): string[] {
  const lines: string[] = [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    const a = before[key] ?? 0;
    const b = after[key] ?? 0;
    if (a !== b) lines.push(`  ${label}.${key} : ${a} → ${b} (${b - a >= 0 ? "+" : ""}${b - a})`);
  }
  return lines;
}

function diffStats(label: string, before: Stats, after: Stats): string[] {
  const lines: string[] = [];
  for (const key of ["min", "p10", "p25", "median", "p75", "p90", "max", "mean"] as const) {
    const a = before[key];
    const b = after[key];
    if (Math.abs(a - b) > 0.0005) lines.push(`  ${label}.${key} : ${a.toFixed(3)} → ${b.toFixed(3)}`);
  }
  return lines;
}

/** Diff lisible entre deux rapports JSON (voir `tools/plan-report --diff`). */
export function diffReports(before: PlanMeasureReport, after: PlanMeasureReport): string[] {
  const lines: string[] = [];
  const names = [...new Set([...before.tracks.map((t) => t.name), ...after.tracks.map((t) => t.name)])].sort();

  lines.push("=== Pistes ===");
  for (const name of names) {
    const a = before.tracks.find((track) => track.name === name);
    const b = after.tracks.find((track) => track.name === name);
    if (a === undefined) {
      lines.push(`+ ${name} : piste ajoutée (${b?.scenes} scènes)`);
      continue;
    }
    if (b === undefined) {
      lines.push(`- ${name} : piste retirée (${a.scenes} scènes)`);
      continue;
    }
    if (a.scenes !== b.scenes) lines.push(`  ${name} : ${a.scenes} → ${b.scenes} scènes`);
    if (a.drops !== b.drops) lines.push(`  ${name} : ${a.drops} → ${b.drops} drops`);
    if (Math.abs(a.duration - b.duration) > 0.0005) {
      lines.push(`  ${name} : durée ${a.duration.toFixed(3)} → ${b.duration.toFixed(3)}`);
    }
  }

  lines.push("\n=== Distributions ===");
  lines.push(...diffCounts("rôles", before.distributions.roles, after.distributions.roles));
  lines.push(...diffCounts("humeurs", before.distributions.moods, after.distributions.moods));
  lines.push(...diffCounts("familles", before.distributions.families, after.distributions.families));
  lines.push(...diffCounts("raisons", before.distributions.reasons, after.distributions.reasons));
  lines.push(
    ...diffCounts(
      "branches famille",
      before.distributions.familyBranches,
      after.distributions.familyBranches,
    ),
  );
  lines.push(
    ...diffCounts("branches humeur", before.distributions.moodBranches, after.distributions.moodBranches),
  );
  lines.push(...diffStats("durées", before.distributions.sceneSpans, after.distributions.sceneSpans));

  if (before.withoutDrops !== undefined && after.withoutDrops !== undefined) {
    lines.push("\n=== Distributions hors scènes de drop ===");
    lines.push(...diffCounts("humeurs", before.withoutDrops.moods, after.withoutDrops.moods));
    lines.push(...diffCounts("familles", before.withoutDrops.families, after.withoutDrops.families));
    lines.push(...diffCounts("raisons", before.withoutDrops.reasons, after.withoutDrops.reasons));
    lines.push(
      ...diffCounts(
        "branches famille",
        before.withoutDrops.familyBranches,
        after.withoutDrops.familyBranches,
      ),
    );
    lines.push(
      ...diffCounts("branches humeur", before.withoutDrops.moodBranches, after.withoutDrops.moodBranches),
    );
    lines.push(
      ...diffStats("durées", before.withoutDrops.sceneSpans, after.withoutDrops.sceneSpans),
    );
  }

  lines.push("\n=== Caractères ===");
  lines.push(...diffStats("énergie", before.characters.energy, after.characters.energy));
  lines.push(...diffStats("densité", before.characters.density, after.characters.density));
  lines.push(...diffStats("brillance", before.characters.brightness, after.characters.brightness));
  if (before.charactersWithoutDrops !== undefined && after.charactersWithoutDrops !== undefined) {
    lines.push("\n=== Caractères hors scènes de drop ===");
    lines.push(
      ...diffStats("énergie", before.charactersWithoutDrops.energy, after.charactersWithoutDrops.energy),
    );
    lines.push(
      ...diffStats("densité", before.charactersWithoutDrops.density, after.charactersWithoutDrops.density),
    );
    lines.push(
      ...diffStats(
        "brillance",
        before.charactersWithoutDrops.brightness,
        after.charactersWithoutDrops.brightness,
      ),
    );
  }

  lines.push("\n=== Scènes modifiées ===");
  let changes = 0;
  for (const name of names) {
    const a = before.scenes.filter((scene) => scene.track === name);
    const b = after.scenes.filter((scene) => scene.track === name);
    const count = Math.max(a.length, b.length);
    for (let index = 0; index < count; index += 1) {
      const old = a[index];
      const current = b[index];
      if (old === undefined || current === undefined) {
        lines.push(`  ${name} #${index} : scène ${old === undefined ? "ajoutée" : "retirée"}`);
        changes += 1;
        continue;
      }
      const fields: string[] = [];
      for (const key of [
        "start",
        "end",
        "family",
        "variant",
        "mood",
        "role",
        "reason",
        "hue",
        "intensity",
        "drop",
      ] as const) {
        if (JSON.stringify(old[key]) !== JSON.stringify(current[key])) {
          fields.push(`${key} ${JSON.stringify(old[key])} → ${JSON.stringify(current[key])}`);
        }
      }
      if (fields.length > 0) {
        lines.push(`  ${name} #${index} (${old.start}→${old.end}) : ${fields.join(", ")}`);
        changes += 1;
      }
    }
  }
  if (changes === 0) lines.push("  (aucune)");
  lines.push(`\n${changes} scène(s) modifiée(s).`);
  return lines;
}
