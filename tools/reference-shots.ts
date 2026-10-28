/**
 * Captures 1080p des titres de référence rap et mesures d'éclairage.
 *
 * Pour chaque titre marqué `"reference": true` dans
 * `tests/support/real_corpus.json`, rend le plan réel avec le harnais headless
 * (`tests/support/headless_render.ts`) à :
 * - chaque drop proposé, à −0,5 s / +0,1 s / +0,5 s ;
 * - le milieu d'un couplet et d'un refrain proposés (meilleure confiance).
 *
 * Écrit les PNG et un JSON de mesures dans `tests/fixtures/reference-shots/`
 * (hors git : l'audio et les captures ne sont pas versionnés).
 *
 *     bun tools/reference-shots.ts
 *     bun tools/reference-shots.ts --out /tmp/opencode/shots --json /tmp/opencode/shots.json
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

import { DEFAULT_SETTINGS, type Analysis } from "../src/types";
import { createHeadlessRenderer } from "../tests/support/headless_render";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_MANIFEST = join(ROOT, "tests/support/real_corpus.json");
const DEFAULT_ANALYSES = join(ROOT, "tests/fixtures/analyses");
const DEFAULT_TRUTH = join(ROOT, "tests/ground-truth");
const DEFAULT_OUT = join(ROOT, "tests/fixtures/reference-shots");

/** Largeur 1080p : 1920 × 1080, densité 1. */
const WIDTH = 1920;
const HEIGHT = 1080;
/** Décalages autour d'un drop : avant, puis deux après. */
const DROP_OFFSETS = [-0.5, 0.1, 0.5] as const;
const DROP_TOLERANCE = 0.5;

interface ManifestEntry {
  id: number;
  titre: string;
  artiste: string;
  reference?: true;
}

interface TruthSection {
  role: string;
  start: number;
  end: number;
  confidence: number;
  source: string;
}

interface Truth {
  titre: string;
  artiste: string;
  id: number;
  bpm: { value: number; confidence: number; source: string };
  sections: TruthSection[];
  drops: Array<{ time: number; confidence: number; source: string }>;
}

interface Moment {
  label: string;
  time: number;
  role: string;
}

interface CaptureMeasure {
  track: string;
  label: string;
  role: string;
  time: number;
  file: string;
  luminanceMean: number;
  whiteRatio: number;
  centerEdgeRatio: number;
  dominantHues: number;
}

function slug(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Milieu de la section de ce rôle avec la meilleure confiance. */
function sectionMidpoint(truth: Truth, role: string): Moment | null {
  const candidates = truth.sections
    .filter((section) => section.role === role && section.end > section.start)
    .sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0];
  if (best === undefined) return null;
  return {
    label: `${role}-${slug(String(best.start))}`,
    time: round((best.start + best.end) / 2),
    role,
  };
}

function momentsFor(truth: Truth, duration: number): Moment[] {
  const moments: Moment[] = [];
  truth.drops.forEach((drop, index) => {
    for (const offset of DROP_OFFSETS) {
      const time = drop.time + offset;
      if (time < 0 || time > duration) continue;
      const suffix = offset < 0 ? "avant" : offset === 0 ? "pile" : "apres";
      moments.push({
        label: `drop${index + 1}-${suffix}-${Math.abs(offset).toFixed(2)}s`,
        time: round(time),
        role: "drop",
      });
    }
  });
  for (const role of ["couplet", "refrain"] as const) {
    const midpoint = sectionMidpoint(truth, role);
    if (midpoint !== null) moments.push(midpoint);
  }
  // Un même instant ne doit pas être capturé deux fois.
  const seen = new Set<string>();
  return moments.filter((moment) => {
    const key = moment.time.toFixed(2);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let manifestPath = DEFAULT_MANIFEST;
  let analysesDir = DEFAULT_ANALYSES;
  let truthDir = DEFAULT_TRUTH;
  let outDir = DEFAULT_OUT;
  let jsonPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => argv[++index];
    if (arg === "--manifest") manifestPath = next() ?? manifestPath;
    else if (arg === "--analyses") analysesDir = next() ?? analysesDir;
    else if (arg === "--truth") truthDir = next() ?? truthDir;
    else if (arg === "--out") outDir = next() ?? outDir;
    else if (arg === "--json") jsonPath = next() ?? null;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "bun tools/reference-shots.ts [--manifest f] [--analyses d] [--truth d] [--out d] [--json f]",
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
    console.error('aucun titre marqué "reference": true dans le manifeste');
    return 1;
  }

  mkdirSync(outDir, { recursive: true });
  const renderer = await createHeadlessRenderer();
  const measures: CaptureMeasure[] = [];
  try {
    for (const entry of references) {
      const analysisPath = join(analysesDir, `real-${entry.id}.json`);
      const truthPath = join(truthDir, `${slug(entry.titre)}.json`);
      if (!existsSync(analysisPath) || !existsSync(truthPath)) {
        console.error(`analyse ou vérité terrain absente pour ${entry.titre}`);
        return 1;
      }
      const analysis = JSON.parse(readFileSync(analysisPath, "utf8")) as Analysis;
      const truth = JSON.parse(readFileSync(truthPath, "utf8")) as Truth;
      await renderer.setup({
        analysis,
        reduced: false,
        width: WIDTH,
        height: HEIGHT,
        dpr: 1,
        quality: 1,
        settings: DEFAULT_SETTINGS,
        reducedMotion: false,
      });
      const trackDir = join(outDir, slug(entry.titre));
      // Un nouveau passage remplace les captures précédentes du même titre.
      rmSync(trackDir, { recursive: true, force: true });
      mkdirSync(trackDir, { recursive: true });
      for (const moment of momentsFor(truth, analysis.duration)) {
        const capture = await renderer.capture(moment.time, Math.round(moment.time * 60));
        const file = `${slug(entry.titre)}-${moment.label}-${moment.time.toFixed(2)}s.png`;
        const base64 = capture.png.replace(/^data:image\/png;base64,/, "");
        writeFileSync(join(trackDir, file), Buffer.from(base64, "base64"));
        measures.push({
          track: entry.titre,
          label: moment.label,
          role: moment.role,
          time: moment.time,
          file: join(slug(entry.titre), file),
          luminanceMean: round(capture.luminanceMean),
          whiteRatio: round(capture.whiteRatio),
          centerEdgeRatio: round(capture.centerEdgeRatio, 2),
          dominantHues: capture.dominantHues,
        });
      }
    }
  } finally {
    await renderer.close();
  }

  const destination = resolve(jsonPath ?? join(outDir, "metrics.json"));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify({ toleranceSec: DROP_TOLERANCE, captures: measures }, null, 2)}\n`);

  console.log("titre      rôle     instant   luminance  blanc   centre/bords  teintes");
  for (const measure of measures) {
    console.log(
      `${measure.track.padEnd(10)} ${measure.role.padEnd(8)} ${measure.time.toFixed(2).padStart(7)}  ` +
        `${measure.luminanceMean.toFixed(3).padStart(9)}  ${(measure.whiteRatio * 100).toFixed(2).padStart(5)} %  ` +
        `${measure.centerEdgeRatio.toFixed(2).padStart(12)}  ${String(measure.dominantHues).padStart(7)}`,
    );
  }
  console.log(`\n${measures.length} captures dans ${outDir}`);
  console.log(`mesures : ${destination}`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
