/**
 * Compare l'analyse et le plan de spectacle aux propositions de vérité terrain
 * des titres de référence rap (`tests/ground-truth/`).
 *
 * Ne modifie rien : lit les analyses réelles (`tests/fixtures/analyses/`), le
 * manifeste (`tests/support/real_corpus.json`) et les JSON de vérité terrain,
 * puis écrit un rapport chiffré. Tous les horodatages sont en secondes et les
 * drops sont comparés avec une tolérance de ±0,5 s.
 *
 *     bun tools/eval-reference.ts
 *     bun tools/eval-reference.ts --json tests/metrics/reference-eval.json
 *
 * Prérequis : `uv run python tools/real_corpus.py` (analyses réelles).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { buildShowPlan, type SceneRole } from "../src/core/show";
import type { Analysis } from "../src/types";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_MANIFEST = join(ROOT, "tests/support/real_corpus.json");
const DEFAULT_ANALYSES = join(ROOT, "tests/fixtures/analyses");
const DEFAULT_TRUTH = join(ROOT, "tests/ground-truth");
/** Tolérance de correspondance d'un drop, en secondes. */
const DROP_TOLERANCE = 0.5;
/** Part minimale d'une section de vérité couverte par une scène du plan. */
const SECTION_COVERAGE = 0.5;

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
  drops: {
    toleranceSec: number;
    proposed: number;
    detected: number;
    found: number;
    missed: number;
    false: number;
    matches: DropMatch[];
    detectedTimes: number[];
  };
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

function compareDrops(truth: Truth, detected: number[]): TrackReport["drops"] {
  const remaining = [...detected];
  const matches: DropMatch[] = [];
  for (const entry of truth.drops) {
    let bestIndex = -1;
    let bestDelta = Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const delta = Math.abs(remaining[index]! - entry.time);
      if (delta <= DROP_TOLERANCE && delta < bestDelta) {
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
  return {
    toleranceSec: DROP_TOLERANCE,
    proposed: truth.drops.length,
    detected: detected.length,
    found,
    missed: truth.drops.length - found,
    false: remaining.length,
    matches,
    detectedTimes: detected.map((time) => round(time)),
  };
}

function evaluateTrack(
  entry: ManifestEntry,
  truth: Truth,
  analysis: Analysis,
): TrackReport {
  const plan = buildShowPlan(analysis, false);
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
    drops: compareDrops(truth, detected),
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

function formatReport(reports: TrackReport[]): string {
  const lines: string[] = [];
  lines.push("titre              BPM détecté / proposé   écart     drops trouvés/manqués/faux   sections couvertes");
  for (const report of reports) {
    const bpm = `${report.bpm.detected.toFixed(1)} / ${report.bpm.proposed.toFixed(1)}`;
    const drop = `${report.drops.found}/${report.drops.missed}/${report.drops.false}`;
    const sections = `${report.sections.coveredSameRole}/${report.sections.total}`;
    lines.push(
      `${report.titre.padEnd(18)} ${bpm.padEnd(22)} ${`${report.bpm.absoluteError.toFixed(1)} BPM`.padEnd(9)} ` +
        `${drop.padEnd(28)} ${sections}`,
    );
  }
  lines.push("");
  for (const report of reports) {
    lines.push(`${report.titre} — rôles : ${Object.entries(report.roles).map(([k, v]) => `${k}×${v}`).join(", ")}`);
    lines.push(
      `  familles : ${Object.entries(report.families).map(([k, v]) => `${k}×${v}`).join(", ")}`,
    );
    const missed = report.sections.details
      .filter((detail) => !detail.coveredSameRole)
      .map((detail) => `${detail.role} ${detail.start.toFixed(1)}–${detail.end.toFixed(1)}`);
    if (missed.length > 0) lines.push(`  sections non couvertes (même rôle) : ${missed.join(" | ")}`);
  }
  return lines.join("\n");
}

function main(): number {
  const argv = process.argv.slice(2);
  let manifestPath = DEFAULT_MANIFEST;
  let analysesDir = DEFAULT_ANALYSES;
  let truthDir = DEFAULT_TRUTH;
  let jsonOut: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => argv[++index];
    if (arg === "--manifest") manifestPath = next() ?? manifestPath;
    else if (arg === "--analyses") analysesDir = next() ?? analysesDir;
    else if (arg === "--truth") truthDir = next() ?? truthDir;
    else if (arg === "--json") jsonOut = next() ?? null;
    else if (arg === "--help" || arg === "-h") {
      console.log("bun tools/eval-reference.ts [--manifest f] [--analyses d] [--truth d] [--json f]");
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

  const text = formatReport(reports);
  console.log(text);
  if (jsonOut !== null) {
    const out = resolve(jsonOut);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify({ toleranceSec: DROP_TOLERANCE, tracks: reports }, null, 2)}\n`);
    console.log(`\nrapport JSON : ${out}`);
  }
  return 0;
}

if (import.meta.main) process.exit(main());
