/**
 * Mesures R3 des passages calmes lumineux et des reprises de référence.
 *
 * Pour les titres marqués `"reference": true` dans le manifeste :
 * - luminance moyenne / minimale / saturation / part de blanc dans chaque
 *   section de vérité `pont` (Focus 137–152, Minimum 124–138, Gogo 96–129) ;
 * - luminance et écart de teinte à +0,1 s de chaque drop validé (±1,5 s) ;
 * - captures 1080p au milieu du calme, 1 s avant la reprise et +0,1 s après.
 *
 * Le mode réduit est mesuré sur les mêmes passages (plafond 0,22).
 *
 *     bun tools/calm-report.ts
 *     bun tools/calm-report.ts --json /tmp/opencode/calm.json --out /tmp/opencode/calm
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { buildShowPlan } from "../src/core/show";
import { DEFAULT_SETTINGS, type Analysis } from "../src/types";
import { createHeadlessRenderer } from "../tests/support/headless_render";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_MANIFEST = join(ROOT, "tests/support/real_corpus.json");
const DEFAULT_ANALYSES = join(ROOT, "tests/fixtures/analyses");
const DEFAULT_TRUTH = join(ROOT, "tests/ground-truth");
const DEFAULT_OUT = join(ROOT, "tests/fixtures/reference-shots/calm");
/** Pas d'échantillonnage des mesures dans un passage calme. */
const SAMPLE_STEP = 0.5;
/** Tolérance de validation d'un drop, en secondes. */
const DROP_TOLERANCE = 1.5;
/** Décalage de mesure après l'impact. */
const LIGHTING_OFFSET = 0.1;

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
}

interface Truth {
  titre: string;
  sections: TruthSection[];
  drops: Array<{ time: number }>;
}

function slug(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function hueGap(left: number, right: number): number {
  const delta = Math.abs(left - right) % 360;
  return delta > 180 ? 360 - delta : delta;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

interface Sample {
  time: number;
  luminance: number;
  saturation: number;
  white: number;
  hue: number;
}

async function sample(
  renderer: Awaited<ReturnType<typeof createHeadlessRenderer>>,
  times: readonly number[],
): Promise<Sample[]> {
  const out: Sample[] = [];
  for (const time of times) {
    const capture = await renderer.capture(time, Math.round(time * 60));
    out.push({
      time: round(time),
      luminance: round(capture.luminanceMean),
      saturation: round(capture.saturationMean ?? 0),
      white: round(capture.whiteRatio),
      hue: round(capture.hueSaturated ?? capture.hueMean ?? 0, 1),
    });
  }
  return out;
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
        "bun tools/calm-report.ts [--manifest f] [--analyses d] [--truth d] [--out d] [--json f]",
      );
      return 0;
    } else {
      console.error(`argument inconnu : ${arg}`);
      return 2;
    }
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestEntry[];
  const references = manifest.filter((entry) => entry.reference === true);
  mkdirSync(outDir, { recursive: true });
  const renderer = await createHeadlessRenderer();
  const report: Array<Record<string, unknown>> = [];
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
      const plan = buildShowPlan(analysis, false, undefined, { dramaturgy: true });
      const beatPeriod = analysis.beatPeriod > 0 ? analysis.beatPeriod : 0.5;
      const measure = Math.max(1, analysis.meter * beatPeriod);
      const calm = truth.sections.find((section) => section.role === "pont");
      if (calm === undefined) continue;

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
      const times: number[] = [];
      for (let time = calm.start + measure; time <= calm.end - measure; time += SAMPLE_STEP) {
        times.push(round(time));
      }
      const calmSamples = await sample(renderer, times);
      // Sous-intervalle réellement classé calme par le plan : sur Focus, la
      // vérité commence à 137 s mais l'analyseur n'entend le pont qu'à 134,1 s.
      const calmScenes = plan.scenes.filter(
        (scene) => scene.mood === "calme" && scene.end > calm.start && scene.start < calm.end,
      );
      const detectedStart = calmScenes.length === 0 ? calm.start : Math.min(...calmScenes.map((scene) => scene.start));
      const detectedEnd = calmScenes.length === 0 ? calm.end : Math.max(...calmScenes.map((scene) => scene.end));
      const detectedTimes: number[] = [];
      for (let time = detectedStart + measure; time <= detectedEnd - measure; time += SAMPLE_STEP) {
        const inside = calmScenes.some((scene) => time >= scene.start && time < scene.end);
        if (inside) detectedTimes.push(round(time));
      }
      const detectedSamples = detectedTimes.length === 0 ? [] : await sample(renderer, detectedTimes);
      const drop = plan.scenes.find(
        (scene) => scene.role === "drop" && scene.start >= calm.start - 1 && scene.start <= calm.end + 3,
      );
      const reprise = drop === undefined ? calm.end : drop.start;
      const beforeTime = round(reprise - 1);
      const repriseTime = round(reprise + LIGHTING_OFFSET);
      const midTime = round((calm.start + calm.end) / 2);
      const before = await sample(renderer, [beforeTime]);
      const after = await sample(renderer, [repriseTime]);
      const calmHue = calmSamples.length === 0 ? 0 : calmSamples[Math.floor(calmSamples.length / 2)]!.hue;

      const trackDir = join(outDir, slug(entry.titre));
      mkdirSync(trackDir, { recursive: true });
      for (const [label, time] of [
        ["calme-milieu", midTime],
        ["calme-avant-reprise", beforeTime],
        ["reprise-plus-010", repriseTime],
      ] as const) {
        const capture = await renderer.capture(time, Math.round(time * 60));
        const base64 = capture.png.replace(/^data:image\/png;base64,/, "");
        writeFileSync(join(trackDir, `${slug(entry.titre)}-${label}-${time.toFixed(2)}s.png`), Buffer.from(base64, "base64"));
      }

      const validDrops = truth.drops
        .map((truthDrop) => {
          const detected = plan.scenes
            .filter((scene) => scene.role === "drop")
            .map((scene) => scene.start)
            .filter((time) => Math.abs(time - truthDrop.time) <= DROP_TOLERANCE)
            .sort((left, right) => Math.abs(left - truthDrop.time) - Math.abs(right - truthDrop.time))[0];
          return detected === undefined ? null : { truth: truthDrop.time, detected };
        })
        .filter((value): value is { truth: number; detected: number } => value !== null);
      const dropMeasures: Array<Record<string, number>> = [];
      for (const item of validDrops) {
        const at = round(item.detected + LIGHTING_OFFSET);
        const capture = await renderer.capture(at, Math.round(at * 60));
        const hue = capture.hueSaturated ?? capture.hueMean ?? 0;
        dropMeasures.push({
          truth: round(item.truth),
          detected: round(item.detected),
          at,
          luminance: round(capture.luminanceMean),
          white: round(capture.whiteRatio),
          hue: round(hue, 1),
          hueGapFromCalm: round(hueGap(calmHue, hue), 1),
        });
      }

      // Mode réduit : mêmes instants, plafond de luminance 0,22.
      await renderer.setup({
        analysis,
        reduced: true,
        width: 1920,
        height: 1080,
        dpr: 1,
        quality: 1,
        settings: { ...DEFAULT_SETTINGS, reduced: true },
        reducedMotion: true,
      });
      const reducedSamples = await sample(renderer, times);

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

      const lum = calmSamples.map((item) => item.luminance);
      const sat = calmSamples.map((item) => item.saturation);
      report.push({
        titre: entry.titre,
        calm: { start: calm.start, end: calm.end, samples: calmSamples.length, series: calmSamples },
        luminanceMean: round(mean(lum)),
        luminanceMin: round(Math.min(...lum)),
        saturationMean: round(mean(sat)),
        whiteMax: round(Math.max(...calmSamples.map((item) => item.white))),
        detectedCalm: {
          start: round(detectedStart),
          end: round(detectedEnd),
          samples: detectedSamples.length,
          luminanceMean: round(mean(detectedSamples.map((item) => item.luminance))),
          luminanceMin:
            detectedSamples.length === 0 ? 0 : round(Math.min(...detectedSamples.map((item) => item.luminance))),
        },
        mid: { time: midTime, luminance: calmSamples[Math.floor(calmSamples.length / 2)]?.luminance ?? 0, hue: calmHue },
        beforeReprise: { time: beforeTime, luminance: before[0]?.luminance ?? 0 },
        reprise: {
          detected: round(reprise),
          time: repriseTime,
          luminance: after[0]?.luminance ?? 0,
          hue: after[0]?.hue ?? 0,
          hueGap: round(hueGap(calmHue, after[0]?.hue ?? 0), 1),
        },
        reduced: {
          luminanceMean: round(mean(reducedSamples.map((item) => item.luminance))),
          luminanceMax: round(Math.max(...reducedSamples.map((item) => item.luminance))),
        },
        drops: dropMeasures,
      });
    }
  } finally {
    await renderer.close();
  }

  console.log("titre     calme        lum.moy  lum.min  sat.moy  blanc.max  reprise  lum.rep  Δteinte  réduit");
  for (const row of report) {
    const calm = row.calm as { start: number; end: number };
    const reprise = row.reprise as { luminance: number; hueGap: number };
    const reduced = row.reduced as { luminanceMean: number };
    console.log(
      `${String(row.titre).padEnd(9)} ${`${calm.start}–${calm.end}`.padEnd(12)} ` +
        `${Number(row.luminanceMean).toFixed(3).padStart(7)}  ${Number(row.luminanceMin).toFixed(3).padStart(7)}  ` +
        `${Number(row.saturationMean).toFixed(2).padStart(7)}  ${Number(row.whiteMax).toFixed(3).padStart(9)}  ` +
        `${Number(reprise.luminance).toFixed(3).padStart(7)}  Δ${reprise.hueGap.toFixed(0).padStart(4)}°  ${reduced.luminanceMean.toFixed(3)}`,
    );
  }
  console.log("\ndrops validés à +0,1 s :");
  for (const row of report) {
    for (const drop of row.drops as Array<Record<string, number>>) {
      console.log(
        `  ${String(row.titre).padEnd(9)} vérité ${drop.truth?.toFixed(1).padStart(6)}  détecté ${drop.detected?.toFixed(2).padStart(7)}  ` +
          `lum ${drop.luminance?.toFixed(3)}  blanc ${drop.white?.toFixed(3)}  Δteinte ${drop.hueGapFromCalm?.toFixed(0)}°`,
      );
    }
  }
  const destination = resolve(jsonPath ?? join(outDir, "metrics.json"));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify({ capture: "1080p", offsetSec: LIGHTING_OFFSET, tracks: report }, null, 2)}\n`);
  console.log(`\nmesures : ${destination}`);
  return 0;
}

if (import.meta.main) process.exit(await main());
