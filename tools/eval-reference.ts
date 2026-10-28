/**
 * Compare l'analyse et le plan de spectacle aux propositions de vérité terrain
 * des titres de référence rap (`tests/ground-truth/`).
 *
 * Ne modifie rien : lit les analyses réelles (`tests/fixtures/analyses/`), le
 * manifeste (`tests/support/real_corpus.json`) et les JSON de vérité terrain,
 * puis écrit un rapport chiffré. Tous les horodatages sont en secondes.
 *
 * Les drops sont évalués à deux tolérances : ±0,5 s (précision historique) et
 * ±1,5 s (tolérance de travail du chantier R2). On rapporte, pour chacune, les
 * vrais/faux/manqués, la précision, le rappel, le F1 et l'écart moyen signé
 * (négatif = en avance, positif = en retard). Les débuts de refrain sont
 * évalués à ±2 s. Enfin, pour chaque drop validé, on mesure la luminance
 * moyenne et la part de blanc du plan à +0,1 s, avec le rendu headless 1080p.
 *
 *     bun tools/eval-reference.ts
 *     bun tools/eval-reference.ts --json tests/metrics/reference-eval.json
 *     bun tools/eval-reference.ts --no-render   # chiffres sans captures
 *
 * Prérequis : `uv run python tools/real_corpus.py` (analyses réelles).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { buildShowPlan, type SceneRole } from "../src/core/show";
import { DEFAULT_SETTINGS, type Analysis } from "../src/types";
import { createHeadlessRenderer } from "../tests/support/headless_render";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_MANIFEST = join(ROOT, "tests/support/real_corpus.json");
const DEFAULT_ANALYSES = join(ROOT, "tests/fixtures/analyses");
const DEFAULT_TRUTH = join(ROOT, "tests/ground-truth");
/** Tolérances de correspondance d'un drop, en secondes. */
const DROP_TOLERANCES = [0.5, 1.5] as const;
/** Tolérance des débuts de refrain, en secondes. */
const REFRAIN_TOLERANCE = 2.0;
/** Part minimale d'une section de vérité couverte par une scène du plan. */
const SECTION_COVERAGE = 0.5;
/** Décalage de la mesure d'éclairage après l'impact. */
const LIGHTING_OFFSET = 0.1;

type TruthRole = SceneRole | "pont";

interface ManifestEntry {
  id: number;
  titre: string;
  artiste: string;
  reference?: true;
}

interface TruthEntry {
  time: number;
  confidence: number;
  source: string;
}

interface TruthSection extends TruthEntry {
  role: TruthRole;
  start: number;
  end: number;
}

interface Truth {
  titre: string;
  artiste: string;
  id: number;
  bpm: { value: number; confidence: number; source: string };
  sections: TruthSection[];
  drops: TruthEntry[];
}

interface DropMatch {
  truth: number;
  detected: number | null;
  delta: number | null;
}

interface DropScore {
  toleranceSec: number;
  proposed: number;
  detected: number;
  found: number;
  missed: number;
  false: number;
  precision: number;
  recall: number;
  f1: number;
  meanSignedDelta: number | null;
  matches: DropMatch[];
  detectedTimes: number[];
}

interface RefrainMatch {
  truth: number;
  detected: number | null;
  delta: number | null;
}

interface LightingMeasure {
  truth: number;
  detected: number;
  offset: number;
  luminanceMean: number;
  whiteRatio: number;
}

interface SectionResult {
  role: TruthRole;
  start: number;
  end: number;
  coveredSameRole: boolean;
  coveredAnyRole: boolean;
}

interface TrackReport {
  titre: string;
  artiste: string;
  id: number;
  duration: number;
  bpm: {
    detected: number;
    proposed: number;
    absoluteError: number;
    relativeError: number;
    confidence: number;
  };
  drops: DropScore[];
  refrains: {
    toleranceSec: number;
    proposed: number;
    found: number;
    missed: number;
    recall: number;
    matches: RefrainMatch[];
    detectedTimes: number[];
  };
  lighting: LightingMeasure[];
  sections: {
    total: number;
    coveredSameRole: number;
    coveredAnyRole: number;
    details: SectionResult[];
  };
  roles: Record<string, number>;
  families: Record<string, number>;
}

function slug(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Map rôle de vérité → rôle de plan attendu. */
function expectedRole(role: TruthRole): SceneRole {
  return role === "pont" ? "montee" : role;
}

function overlap(start: number, end: number, sceneStart: number, sceneEnd: number): number {
  return Math.max(0, Math.min(end, sceneEnd) - Math.max(start, sceneStart));
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function scoreDrops(truth: Truth, detected: number[], tolerance: number): DropScore {
  const remaining = [...detected];
  const matches: DropMatch[] = [];
  for (const entry of truth.drops) {
    let bestIndex = -1;
    let bestDelta = Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const delta = Math.abs(remaining[index]! - entry.time);
      if (delta <= tolerance && delta < bestDelta) {
        bestDelta = delta;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      const at = remaining.splice(bestIndex, 1)[0]!;
      matches.push({ truth: entry.time, detected: at, delta: round(at - entry.time) });
    } else {
      matches.push({ truth: entry.time, detected: null, delta: null });
    }
  }
  const found = matches.filter((match) => match.detected !== null).length;
  const deltas = matches
    .map((match) => match.delta)
    .filter((delta): delta is number => delta !== null);
  const precision = ratio(found, detected.length);
  const recall = ratio(found, truth.drops.length);
  return {
    toleranceSec: tolerance,
    proposed: truth.drops.length,
    detected: detected.length,
    found,
    missed: truth.drops.length - found,
    false: remaining.length,
    precision: round(precision),
    recall: round(recall),
    f1: round(ratio(2 * precision * recall, precision + recall)),
    meanSignedDelta:
      deltas.length === 0
        ? null
        : round(deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length),
    matches,
    detectedTimes: detected.map((time) => round(time)),
  };
}

function scoreRefrains(
  truth: Truth,
  analysis: Analysis,
): TrackReport["refrains"] {
  const starts = truth.sections
    .filter((section) => section.role === "refrain")
    .map((section) => section.start);
  // Le rôle refrain du plan cède la place à un drop quand les deux tombent au
  // même instant (c'est l'impact qui commande la lumière). On évalue donc le
  // début de refrain sur le découpage produit par l'analyseur, qui porte
  // l'information « ce bloc est un refrain », et on rapporte les rôles du plan
  // séparément.
  const detected = analysis.sections
    .filter((section) => section.kind === "refrain")
    .map((section) => section.start);
  const remaining = [...detected];
  const matches: RefrainMatch[] = [];
  for (const start of starts) {
    let bestIndex = -1;
    let bestDelta = Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const delta = Math.abs(remaining[index]! - start);
      if (delta <= REFRAIN_TOLERANCE && delta < bestDelta) {
        bestDelta = delta;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      const at = remaining.splice(bestIndex, 1)[0]!;
      matches.push({ truth: start, detected: at, delta: round(at - start) });
    } else {
      matches.push({ truth: start, detected: null, delta: null });
    }
  }
  const found = matches.filter((match) => match.detected !== null).length;
  return {
    toleranceSec: REFRAIN_TOLERANCE,
    proposed: starts.length,
    found,
    missed: starts.length - found,
    recall: round(ratio(found, starts.length)),
    matches,
    detectedTimes: detected.map((time) => round(time)),
  };
}

function evaluateTrack(entry: ManifestEntry, truth: Truth, analysis: Analysis): TrackReport {
  const plan = buildShowPlan(analysis, false, undefined, { dramaturgy: true });
  const detected = plan.scenes
    .filter((scene) => scene.role === "drop")
    .map((scene) => scene.start);
  const bpmError = Math.abs(analysis.tempo - truth.bpm.value);

  const details: SectionResult[] = truth.sections.map((section) => {
    const expected = expectedRole(section.role);
    const span = Math.max(section.end - section.start, 1e-6);
    const sameRoleOverlap = plan.scenes
      .filter((scene) => scene.role === expected)
      .reduce(
        (total, scene) => total + overlap(section.start, section.end, scene.start, scene.end),
        0,
      );
    const anyRoleOverlap = plan.scenes.reduce(
      (total, scene) => total + overlap(section.start, section.end, scene.start, scene.end),
      0,
    );
    return {
      role: section.role,
      start: section.start,
      end: section.end,
      coveredSameRole: sameRoleOverlap >= SECTION_COVERAGE * span,
      coveredAnyRole: anyRoleOverlap >= SECTION_COVERAGE * span,
    };
  });

  const roles: Record<string, number> = {};
  const families: Record<string, number> = {};
  for (const scene of plan.scenes) {
    roles[scene.role] = (roles[scene.role] ?? 0) + 1;
    families[scene.family] = (families[scene.family] ?? 0) + 1;
  }

  return {
    titre: entry.titre,
    artiste: entry.artiste,
    id: entry.id,
    duration: round(analysis.duration, 2),
    bpm: {
      detected: analysis.tempo,
      proposed: truth.bpm.value,
      absoluteError: round(bpmError, 3),
      relativeError: round((bpmError / truth.bpm.value) * 100, 1),
      confidence: truth.bpm.confidence,
    },
    drops: DROP_TOLERANCES.map((tolerance) => scoreDrops(truth, detected, tolerance)),
    refrains: scoreRefrains(truth, analysis),
    lighting: [],
    sections: {
      total: details.length,
      coveredSameRole: details.filter((detail) => detail.coveredSameRole).length,
      coveredAnyRole: details.filter((detail) => detail.coveredAnyRole).length,
      details,
    },
    roles,
    families,
  };
}

async function measureLighting(
  reports: TrackReport[],
  analysesDir: string,
): Promise<void> {
  const renderer = await createHeadlessRenderer();
  try {
    for (const report of reports) {
      const analysisPath = join(analysesDir, `real-${report.id}.json`);
      const analysis = JSON.parse(readFileSync(analysisPath, "utf8")) as Analysis;
      const validated = report.drops.find((drop) => drop.toleranceSec === 1.5)?.matches ?? [];
      const captures = validated.filter(
        (match): match is DropMatch & { detected: number } => match.detected !== null,
      );
      if (captures.length === 0) continue;
      await renderer.setup({
        analysis,
        reduced: false,
        width: 1920,
        height: 1080,
        dpr: 1,
        quality: 1,
        settings: DEFAULT_SETTINGS,
        reducedMotion: false,
      });
      for (const match of captures) {
        const at = round(match.detected + LIGHTING_OFFSET);
        const capture = await renderer.capture(at, Math.round(at * 60));
        report.lighting.push({
          truth: match.truth,
          detected: match.detected,
          offset: LIGHTING_OFFSET,
          luminanceMean: round(capture.luminanceMean),
          whiteRatio: round(capture.whiteRatio),
        });
      }
    }
  } finally {
    await renderer.close();
  }
}

function formatReport(reports: TrackReport[]): string {
  const lines: string[] = [];
  lines.push(
    "titre              drops ±0,5 (justes/faux/manqués, F1, écart)   drops ±1,5 (justes/faux/manqués, F1, écart)   refrains",
  );
  for (const report of reports) {
    const narrow = report.drops.find((drop) => drop.toleranceSec === 0.5);
    const wide = report.drops.find((drop) => drop.toleranceSec === 1.5);
    if (narrow === undefined || wide === undefined) continue;
    const cell = (score: DropScore) =>
      `${score.found}/${score.false}/${score.missed} F1=${score.f1.toFixed(2)} Δ=${
        score.meanSignedDelta === null ? "—" : score.meanSignedDelta.toFixed(2)
      }`;
    const refrain = `${report.refrains.found}/${report.refrains.proposed}`;
    lines.push(
      `${report.titre.padEnd(18)} ${cell(narrow).padEnd(43)} ${cell(wide).padEnd(43)} ${refrain}`,
    );
  }
  lines.push("");
  for (const report of reports) {
    const bpm = `${report.bpm.detected.toFixed(1)} / ${report.bpm.proposed.toFixed(1)}`;
    lines.push(
      `${report.titre} — BPM ${bpm} (écart ${report.bpm.absoluteError.toFixed(1)}) — rôles : ${Object.entries(
        report.roles,
      )
        .map(([key, value]) => `${key}×${value}`)
        .join(", ")}`,
    );
    lines.push(
      `  familles : ${Object.entries(report.families)
        .map(([key, value]) => `${key}×${value}`)
        .join(", ")}`,
    );
    const wide = report.drops.find((drop) => drop.toleranceSec === 1.5);
    if (wide !== undefined) {
      const missed = wide.matches
        .filter((match) => match.detected === null)
        .map((match) => match.truth.toFixed(1));
      const falseTimes = wide.detectedTimes.filter(
        (time) => !wide.matches.some((match) => match.detected !== null && Math.abs(match.detected - time) < 1e-6),
      );
      if (missed.length > 0) lines.push(`  drops manqués (±1,5) : ${missed.join(", ")}`);
      if (falseTimes.length > 0) lines.push(`  faux drops (±1,5) : ${falseTimes.join(", ")}`);
    }
    if (report.refrains.proposed > 0) {
      const missed = report.refrains.matches
        .filter((match) => match.detected === null)
        .map((match) => match.truth.toFixed(1));
      if (missed.length > 0) lines.push(`  refrains manqués : ${missed.join(", ")}`);
    }
    const missedSections = report.sections.details
      .filter((detail) => !detail.coveredSameRole)
      .map((detail) => `${detail.role} ${detail.start.toFixed(1)}–${detail.end.toFixed(1)}`);
    if (missedSections.length > 0)
      lines.push(`  sections non couvertes (même rôle) : ${missedSections.join(" | ")}`);
  }
  lines.push("");
  lines.push("éclairage à +0,1 s des drops validés (±1,5) :");
  for (const report of reports) {
    for (const measure of report.lighting) {
      lines.push(
        `  ${report.titre.padEnd(10)} vérité ${measure.truth.toFixed(2).padStart(7)}  ` +
          `détecté ${measure.detected.toFixed(2).padStart(7)}  ` +
          `luminance ${measure.luminanceMean.toFixed(3)}  blanc ${(measure.whiteRatio * 100).toFixed(2)} %`,
      );
    }
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let manifestPath = DEFAULT_MANIFEST;
  let analysesDir = DEFAULT_ANALYSES;
  let truthDir = DEFAULT_TRUTH;
  let jsonOut: string | null = null;
  let render = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => argv[++index];
    if (arg === "--manifest") manifestPath = next() ?? manifestPath;
    else if (arg === "--analyses") analysesDir = next() ?? analysesDir;
    else if (arg === "--truth") truthDir = next() ?? truthDir;
    else if (arg === "--json") jsonOut = next() ?? null;
    else if (arg === "--no-render") render = false;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "bun tools/eval-reference.ts [--manifest f] [--analyses d] [--truth d] [--json f] [--no-render]",
      );
      return 0;
    } else {
      console.error(`argument inconnu : ${arg}`);
      return 2;
    }
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestEntry[];
  const references = manifest.filter((entry) => entry.reference === true);
  if (references.length === 0) {
    console.error("aucun titre marqué \"reference\": true dans le manifeste");
    return 1;
  }

  const reports: TrackReport[] = [];
  for (const entry of references) {
    const analysisPath = join(analysesDir, `real-${entry.id}.json`);
    const truthPath = join(truthDir, `${slug(entry.titre)}.json`);
    if (!existsSync(analysisPath)) {
      console.error(
        `analyse absente pour ${entry.titre} : ${analysisPath}\n` +
          "lancer : uv run python tools/real_corpus.py",
      );
      return 1;
    }
    if (!existsSync(truthPath)) {
      console.error(`vérité terrain absente pour ${entry.titre} : ${truthPath}`);
      return 1;
    }
    const analysis = JSON.parse(readFileSync(analysisPath, "utf8")) as Analysis;
    const truth = JSON.parse(readFileSync(truthPath, "utf8")) as Truth;
    reports.push(evaluateTrack(entry, truth, analysis));
  }

  if (render) {
    try {
      await measureLighting(reports, analysesDir);
    } catch (error) {
      console.error(`captures indisponibles : ${(error as Error).message}`);
    }
  }

  console.log(formatReport(reports));
  if (jsonOut !== null) {
    const out = resolve(jsonOut);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      `${JSON.stringify(
        { dropTolerancesSec: DROP_TOLERANCES, refrainToleranceSec: REFRAIN_TOLERANCE, tracks: reports },
        null,
        2,
      )}\n`,
    );
    console.log(`\nrapport JSON : ${out}`);
  }
  return 0;
}

if (import.meta.main) process.exit(await main());
