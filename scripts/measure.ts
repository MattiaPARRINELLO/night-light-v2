/**
 * Harnais de métriques partagé (agents A/B et passe de fusion).
 *
 * Pour chaque piste du corpus de référence (tests/support/make_fixture.py) :
 *   analyse réelle (`analyze_file`, via scripts/analyze_corpus.py)
 *   → `buildShowPlan`
 *   → échantillonnage du rendu à 30 images/s par `renderFrame`.
 *
 * Sortie : un JSON stable (clés triées) qui ne contient que des mesures
 * déterministes, sauf la section `timing` (temps de calcul et mémoire).
 *
 *   bun scripts/measure.ts --label baseline
 *   bun scripts/measure.ts --out docs/metrics/A.json
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { caractereAt, buildShowPlan, sceneAt, type Scene } from "../src/core/show";
import {
  beatDrive,
  beatStrength,
  ENERGY_FLOOR,
  flashAdmitted,
  flashAlpha,
  renderFrame,
  sceneHue,
  surgeAlpha,
  variationStrength,
  visibleEnergy,
} from "../src/core/render";
import { createTrackView } from "../src/core/view";
import { DEFAULT_SETTINGS, type Analysis, type RenderSettings } from "../src/types";
import type { FrameState } from "../src/core/families";

const ROOT = resolve(import.meta.dir, "..");
const CORPUS_DIR = join(ROOT, "tests/fixtures/corpus");
const FPS = 30;

/* --------------------------------------------------------------- utilitaires */

function round6(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function circularDistance(left: number, right: number): number {
  return Math.abs((((left - right) % 360) + 540) % 360 - 180);
}

function histogram(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** JSON à clés triées : deux exécutions identiques produisent les mêmes octets. */
function stableStringify(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        out[key] = sort((input as Record<string, unknown>)[key]);
      }
      return out;
    }
    return input;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/* ---------------------------------------------------------- contexte factice */

/**
 * Contexte 2D sans rasterisation : le rendu exécute exactement le même chemin
 * de code (familles, dégradés, flashs) sans payer le dessin. Toutes les méthodes
 * inconnues sont des no-ops, les propriétés sont mémorisées.
 */
function nullContext(width: number, height: number): CanvasRenderingContext2D {
  const gradient = { addColorStop() {} };
  const base: Record<string | symbol, unknown> = {
    canvas: { width, height },
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    strokeStyle: "",
    fillStyle: "",
    filter: "none",
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => null,
    measureText: () => ({ width: 0 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  return new Proxy(base, {
    get(target, property) {
      if (property in target) return target[property];
      return () => undefined;
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/* --------------------------------------------------------------- plan */

interface PlanMetrics {
  sceneCount: number;
  familyHistogram: Record<string, number>;
  longestFamilyStreak: number;
  topFamilyShare: number;
  moodHistogram: Record<string, number>;
  roleHistogram: Record<string, number>;
  dropSceneCount: number;
  dropReasons: Record<string, number>;
  dropFamilies: Record<string, number>;
  brightSceneShare: number;
  meanSceneBrightness: number;
  adjacentHueGapMinDeg: number;
  adjacentHueGapMedianDeg: number;
  hueWindowDeg: number;
}

function planMetrics(analysis: Analysis, plan: ReturnType<typeof buildShowPlan>): PlanMetrics {
  const scenes = plan.scenes;
  const families = scenes.map((scene) => scene.family);
  let longestStreak = 0;
  let streak = 0;
  let previous: string | null = null;
  for (const family of families) {
    streak = family === previous ? streak + 1 : 1;
    previous = family;
    if (streak > longestStreak) longestStreak = streak;
  }
  const counts = histogram(families);
  const top = Object.values(counts).sort((left, right) => right - left)[0] ?? 0;

  const gaps: number[] = [];
  for (let index = 1; index < scenes.length; index += 1) {
    gaps.push(circularDistance(scenes[index]!.palette.hue, scenes[index - 1]!.palette.hue));
  }
  const hues = scenes.map((scene) => scene.palette.hue);

  const brightness = scenes.map(
    (scene) => caractereAt(analysis, scene.start, scene.end).brightness,
  );
  const drops = scenes.filter((scene) => scene.role === "drop");

  return {
    sceneCount: scenes.length,
    familyHistogram: counts,
    longestFamilyStreak: longestStreak,
    topFamilyShare: scenes.length === 0 ? 0 : round6(top / scenes.length),
    moodHistogram: histogram(scenes.map((scene) => scene.mood)),
    roleHistogram: histogram(scenes.map((scene) => scene.role)),
    dropSceneCount: drops.length,
    dropReasons: histogram(drops.map((scene) => scene.reason)),
    dropFamilies: histogram(drops.map((scene) => scene.family)),
    brightSceneShare: scenes.length === 0 ? 0 : round6(brightness.filter((value) => value > 0.62).length / scenes.length),
    meanSceneBrightness: round6(mean(brightness)),
    adjacentHueGapMinDeg: round6(gaps.length === 0 ? 360 : Math.min(...gaps)),
    adjacentHueGapMedianDeg: round6(median(gaps)),
    hueWindowDeg: round6(hues.length === 0 ? 0 : Math.max(...hues) - Math.min(...hues)),
  };
}

/* -------------------------------------------------------------- rendu */

interface FlashEvent {
  drop: boolean;
  alpha: number;
}

interface RenderMetrics {
  frames: number;
  maxHueDeltaDeg: number;
  maxHueDeltaOutsideEventDeg: number;
  maxDriftFromSceneHueDeg: number;
  flashesPerMinute: number;
  flashEventCount: number;
  dropFlashEventCount: number;
  flashAlphaMax: number;
  flashAlphaMedian: number;
  dropFlashAlphaMedian: number;
  ordinaryFlashAlphaMedian: number;
  backgroundLightnessMean: number;
  backgroundLightnessMin: number;
  backgroundLightnessMax: number;
  /** Fraction d'images où l'énergie BRUTE est sous le plancher (diagnostic). */
  rawEnergyBelowFloorShare: number;
  /** Fraction d'images où l'énergie VISIBLE est sous le plancher (doit rester 0). */
  visibleEnergyBelowFloorShare: number;
}

/**
 * Mesure le rendu sur toute la piste.
 *
 * La teinte, les flashs et le fond sont calculés avec les mêmes fonctions
 * exportées que `renderFrame` (sceneHue, flashAlpha, surgeAlpha, flashAdmitted,
 * beatStrength) et les mêmes entrées ; `renderFrame` est exécuté à chaque image
 * pour vérifier qu'il ne lève pas et pour mesurer son coût.
 */
function renderMetrics(
  analysis: Analysis,
  plan: ReturnType<typeof buildShowPlan>,
  settings: RenderSettings,
): { metrics: RenderMetrics; timing: { medianMs: number; p95Ms: number; peakMemoryBytes: number } } {
  const view = createTrackView(analysis);
  const ctx = nullContext(1280, 720);
  const builds = analysis.builds.length;
  const step = 1 / FPS;
  const samples: number[] = [];
  const hues: number[] = [];
  const hueDeltas: number[] = [];
  const hueDeltasOutside: number[] = [];
  const drifts: number[] = [];
  const background: number[] = [];
  let rawBelowFloor = 0;
  let visibleBelowFloor = 0;
  const events: FlashEvent[] = [];
  let inEvent = false;
  let eventPeak = 0;
  let eventDrop = false;
  let lastEventTime = -Infinity;
  const memoryStart = process.memoryUsage().rss;
  let peakMemory = memoryStart;
  let frames = 0;

  const flushEvent = () => {
    if (inEvent) {
      events.push({ drop: eventDrop, alpha: eventPeak });
      inEvent = false;
      eventPeak = 0;
      eventDrop = false;
    }
  };

  for (let t = 0; t < analysis.duration; t += step) {
    const scene: Scene = sceneAt(plan, t);
    const drop = Math.max(view.buildIntensity(t), beatDrive(view, t, builds) * 0.6);
    const variation = variationStrength(scene, t);
    const hue = sceneHue(scene, t, drop, variation, false);
    hues.push(hue);
    drifts.push(circularDistance(hue, scene.palette.hue));

    const energy = visibleEnergy(view.energyAt(t));
    const beat = beatStrength(view, t);
    const surge = view.energyTrend(t, 1.2);
    const rawEnergy = view.energyAt(t);
    if (rawEnergy < ENERGY_FLOOR) rawBelowFloor += 1;
    if (energy < ENERGY_FLOOR) visibleBelowFloor += 1;

    const frameState = {
      reduced: false,
      beat,
      bass: view.bassAt(t),
      build: view.buildProgress(t),
      buildStrength: view.buildAt(t)?.strength ?? 0,
      energy,
      surge,
    } as unknown as FrameState;
    const flash = Math.max(flashAlpha(frameState, settings), surgeAlpha(frameState, settings));
    const admitted = flash > 0.002 && flashAdmitted(view, t);
    const dropCause = view.buildsEndingIn(t - 0.2, t).length > 0;

    if (admitted) {
      if (!inEvent || t - lastEventTime > 0.3) {
        flushEvent();
        inEvent = true;
        lastEventTime = t;
        eventDrop = dropCause;
      }
      const alpha = flash * (0.5 + 0.5 * (0.7 + 0.3 * energy));
      if (alpha > eventPeak) eventPeak = alpha;
    } else if (inEvent && t - lastEventTime > 0.3) {
      flushEvent();
    }

    // Fond : mêmes expressions que `drawBackground` (render.ts:91-96), en
    // luminosité HSL. Le fond est opaque, donc l'alpha ne dit rien : c'est la
    // luminosité qui révèle un écran noir.
    const glow = 0.02 + energy * 0.05 + view.bassAt(t) * 0.05;
    background.push((0.035 + glow * 0.5 + 0.05 + glow) / 2);

    const started = performance.now();
    renderFrameCall(ctx, analysis, plan, view, t, frames);
    samples.push(performance.now() - started);
    frames += 1;
    if (frames % 30 === 0) {
      peakMemory = Math.max(peakMemory, process.memoryUsage().rss);
    }
  }
  flushEvent();
  peakMemory = Math.max(peakMemory, process.memoryUsage().rss);

  for (let index = 1; index < hues.length; index += 1) {
    const delta = circularDistance(hues[index]!, hues[index - 1]!);
    hueDeltas.push(delta);
    const t = index * step;
    const event =
      variationStrength(sceneAt(plan, t), t) > 0.05 ||
      view.buildsEndingIn(t - 0.4, t + 0.4).length > 0;
    if (!event) hueDeltasOutside.push(delta);
  }

  const dropEvents = events.filter((event) => event.drop);
  const ordinaryEvents = events.filter((event) => !event.drop);
  const minutes = Math.max(analysis.duration / 60, 1e-9);
  return {
    metrics: {
      frames,
      maxHueDeltaDeg: round6(hueDeltas.length === 0 ? 0 : Math.max(...hueDeltas)),
      maxHueDeltaOutsideEventDeg: round6(hueDeltasOutside.length === 0 ? 0 : Math.max(...hueDeltasOutside)),
      maxDriftFromSceneHueDeg: round6(drifts.length === 0 ? 0 : Math.max(...drifts)),
      flashesPerMinute: round6(events.length / minutes),
      flashEventCount: events.length,
      dropFlashEventCount: dropEvents.length,
      flashAlphaMax: round6(events.length === 0 ? 0 : Math.max(...events.map((event) => event.alpha))),
      flashAlphaMedian: round6(median(events.map((event) => event.alpha))),
      dropFlashAlphaMedian: round6(median(dropEvents.map((event) => event.alpha))),
      ordinaryFlashAlphaMedian: round6(median(ordinaryEvents.map((event) => event.alpha))),
      backgroundLightnessMean: round6(mean(background)),
      backgroundLightnessMin: round6(background.length === 0 ? 0 : Math.min(...background)),
      backgroundLightnessMax: round6(background.length === 0 ? 0 : Math.max(...background)),
      rawEnergyBelowFloorShare: round6(rawBelowFloor / Math.max(frames, 1)),
      visibleEnergyBelowFloorShare: round6(visibleBelowFloor / Math.max(frames, 1)),
    },
    timing: {
      medianMs: round6(median(samples)),
      p95Ms: round6(percentile(samples, 0.95)),
      peakMemoryBytes: Math.max(0, peakMemory - memoryStart),
    },
  };
}

/** Appel isolé pour mesurer le coût sans que TypeScript n'élague l'appel. */
function renderFrameCall(
  ctx: CanvasRenderingContext2D,
  _analysis: Analysis,
  plan: ReturnType<typeof buildShowPlan>,
  view: ReturnType<typeof createTrackView>,
  time: number,
  frame: number,
): void {
  renderFrame({
    ctx,
    width: 1280,
    height: 720,
    dpr: 1,
    time,
    view,
    plan,
    settings: DEFAULT_SETTINGS,
    reducedMotion: false,
    quality: 1,
    frame,
  });
}

/* -------------------------------------------------------------- corpus */

function generateCorpus(): void {
  const existing = existsSync(CORPUS_DIR) ? readdirSync(CORPUS_DIR).filter((name) => name.endsWith(".wav")) : [];
  if (existing.length >= 10) return;
  process.stderr.write("corpus absent : génération (tests/support/make_fixture.py)...\n");
  const result = spawnSync("uv", ["run", "python", "tests/support/make_fixture.py", "corpus", CORPUS_DIR], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("génération du corpus impossible");
}

function corpusHash(): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(CORPUS_DIR).filter((entry) => entry.endsWith(".wav")).sort()) {
    hash.update(name);
    hash.update(readFileSync(join(CORPUS_DIR, name)));
  }
  return hash.digest("hex");
}

interface CorpusAnalyses {
  name: string;
  analysis: Analysis;
}

function analyzeCorpus(): CorpusAnalyses[] {
  const directory = mkdtempSync(join(tmpdir(), "night-light-measure-"));
  const out = join(directory, "analyses.json");
  const result = spawnSync(
    "uv",
    ["run", "python", "scripts/analyze_corpus.py", "--corpus", CORPUS_DIR, "--out", out],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error("analyse du corpus impossible");
  return JSON.parse(readFileSync(out, "utf8")) as CorpusAnalyses[];
}

/* --------------------------------------------------------------- main */

const args = process.argv.slice(2);
let label = "baseline";
let outPath = "";
let fps = FPS;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--label") label = args[++index] ?? label;
  else if (arg === "--out") outPath = args[++index] ?? outPath;
  else if (arg === "--fps") fps = Number(args[++index] ?? fps);
  else if (arg === "--help" || arg === "-h") {
    process.stdout.write("usage : bun scripts/measure.ts [--label baseline|A|B|fusion] [--out fichier.json] [--fps 30]\n");
    process.exit(0);
  }
}
if (fps !== FPS) {
  process.stderr.write("le pas d'échantillonnage des métriques est fixé à 30 images/s\n");
  process.exit(2);
}
const destination = outPath || join(ROOT, "docs/metrics", `${label}.json`);

generateCorpus();
const analyses = analyzeCorpus();
const tracks: Record<string, unknown> = {};

for (const { name, analysis } of analyses) {
  const plan = buildShowPlan(analysis, false);
  const planData = planMetrics(analysis, plan);
  const { metrics, timing } = renderMetrics(analysis, plan, DEFAULT_SETTINGS);
  tracks[name] = {
    analysis: {
      duration: round6(analysis.duration),
      tempo: round6(analysis.tempo),
      beatCount: analysis.beats.length,
      onsetCount: analysis.onsets.length,
      buildCount: analysis.builds.length,
      sectionCount: analysis.sections.length,
      coverage: analysis.coverage ?? null,
    },
    plan: planData,
    render: metrics,
    timing,
  };
  process.stderr.write(`mesuré : ${name}\n`);
}

const values = Object.values(tracks) as Array<Record<string, any>>;
const aggregate = {
  trackCount: values.length,
  meanSceneCount: round6(mean(values.map((track) => track.plan.sceneCount))),
  meanTopFamilyShare: round6(mean(values.map((track) => track.plan.topFamilyShare))),
  meanBrightSceneShare: round6(mean(values.map((track) => track.plan.brightSceneShare))),
  meanFlashesPerMinute: round6(mean(values.map((track) => track.render.flashesPerMinute))),
  meanMaxHueDeltaDeg: round6(mean(values.map((track) => track.render.maxHueDeltaDeg))),
  meanMaxDriftFromSceneHueDeg: round6(mean(values.map((track) => track.render.maxDriftFromSceneHueDeg))),
  meanBackgroundLightness: round6(mean(values.map((track) => track.render.backgroundLightnessMean))),
  totalDeadVisibleFrames: values.reduce((total, track) => total + track.render.visibleEnergyBelowFloorShare, 0),
};

const payload = {
  label,
  harness: "scripts/measure.ts",
  fps,
  corpus: { hash: corpusHash(), tracks: analyses.length },
  tools: { bun: Bun.version, node: process.version },
  tracks,
  aggregate,
};

mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, stableStringify(payload), "utf8");
process.stderr.write(`\n${destination}\n`);
