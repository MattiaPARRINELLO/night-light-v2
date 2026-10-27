#!/usr/bin/env bun
/**
 * Mesure de saturation pendant les drops, à 10 Hz.
 *
 *   bun tools/saturation-report.ts [--corpus <dir>] [--real <fichier|dir>]... [--out <json>]
 *                                   [--width] [--flashes]
 *
 * "Saturation" = part de pixels proches du blanc (luminance > 0,92 et
 * saturation < 0,15), mesurée sur une image réellement rendue par Chromium
 * headless. Chaque scène de rôle `drop` est échantillonnée toutes les 100 ms.
 *
 * `--width`   ajoute la largeur d'impact (durée > 50 % du pic) par drop, à
 *             30 Hz, et la corrélation de Spearman force ↔ pic.
 * `--flashes` ajoute les flashs/s par morceau (transitions rapides de luminance
 *             moyenne > 10 %), en mode normal ET réduit, sur tout le morceau.
 *
 * Sortie texte lisible ; `--out` écrit aussi le JSON machine (échantillons
 * compris). Aucune écriture sans `--out`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { buildShowPlan } from "../src/core/show";
import { TrackView } from "../src/core/view";
import { DEFAULT_SETTINGS } from "../src/types";
import { DEFAULT_CORPUS_DIR, loadCorpusAnalyses, loadRealAnalyses } from "../tests/support/plan_corpus";
import { stats } from "../tests/support/plan_report";
import {
  aggregateSaturation,
  sampleDrops,
  sampleTimes,
  type DropSaturation,
  type DropWindow,
} from "../tests/support/drop_saturation";
import { createHeadlessRenderer, type FrameMetric, type HeadlessRenderer } from "../tests/support/headless_render";
import { stableStringify } from "../tests/support/plan_snapshot";

/** Cadence de la métrique photosensible et de la largeur d'impact. */
export const METRIC_FPS = 30;
/** Seuil d'une transition de luminance moyenne, en luminance absolue 0..1. */
export const FLASH_DELTA = 0.1;
/** Fenêtre d'observation d'une montée et de sa descente, en secondes. */
const FLASH_HALF_WINDOW_SEC = 0.5;
/** Fenêtre réglementaire (WCAG 2.3.1) de comptage des flashs. */
const FLASH_WINDOW_SEC = 1;
/** Transition de part de blanc qui signe un flash plein écran (et non un pulse coloré). */
const WHITE_FLASH_DELTA = 0.05;

function formatStats(value: ReturnType<typeof stats>): string {
  return `moy ${value.mean.toFixed(4)} · méd ${value.median.toFixed(4)} · p90 ${value.p90.toFixed(4)} · max ${value.max.toFixed(4)}`;
}

/**
 * Indices des pics de luminance qui forment un flash.
 *
 * Un flash = une **transition rapide** de luminance moyenne : une montée d'au
 * moins `FLASH_DELTA` entre deux échantillons consécutifs, puis une descente
 * d'au moins `FLASH_DELTA` dans la demi-seconde qui suit. Compter les marches
 * d'échantillon à échantillon (et non la pente lente d'un pulsage musical)
 * évite de confondre un temps fort de 170 BPM avec un flash.
 */
export function detectFlashTimes(
  luminances: ReadonlyArray<number>,
  fps: number,
  delta = FLASH_DELTA,
): number[] {
  const lookahead = Math.max(1, Math.round(FLASH_HALF_WINDOW_SEC * fps));
  const times: number[] = [];
  for (let index = 1; index < luminances.length; index += 1) {
    const rise = (luminances[index] ?? 0) - (luminances[index - 1] ?? 0);
    if (rise < delta) continue;
    let peak = index;
    let fallen = false;
    for (let after = index; after <= Math.min(luminances.length - 1, index + lookahead); after += 1) {
      if ((luminances[after] ?? 0) > (luminances[peak] ?? 0)) peak = after;
      const fall = (luminances[after] ?? 0) - (luminances[after + 1] ?? luminances[after] ?? 0);
      if (after > peak && fall >= delta) {
        fallen = true;
        break;
      }
    }
    if (!fallen) continue;
    times.push(peak / fps);
    // Sauter les échantillons du même évènement (montée, plateau, descente).
    index = Math.min(luminances.length - 1, peak + Math.max(1, Math.round(0.15 * fps)));
  }
  return times;
}

/** Nombre maximal de flashs dans une fenêtre glissante de 1 s. */
export function maxFlashesPerSecond(times: ReadonlyArray<number>): { max: number; at: number | null } {
  let max = 0;
  let at: number | null = null;
  let end = 0;
  const tolerance = 1e-9;
  for (let start = 0; start < times.length; start += 1) {
    while (end < times.length && (times[end] ?? 0) < (times[start] ?? 0) + FLASH_WINDOW_SEC - tolerance) end += 1;
    const count = end - start;
    if (count > max) {
      max = count;
      at = times[start] ?? null;
    }
  }
  return { max, at };
}

/** Rang moyen, pour la corrélation de Spearman avec ex æquo. */
function ranks(values: ReadonlyArray<number>): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const out = Array.from<number>({ length: values.length }).fill(0);
  let index = 0;
  while (index < order.length) {
    let end = index + 1;
    while (end < order.length && (order[end]?.value ?? 0) === (order[index]?.value ?? 0)) end += 1;
    const rank = (index + end - 1) / 2 + 1;
    for (let cursor = index; cursor < end; cursor += 1) out[order[cursor]!.index] = rank;
    index = end;
  }
  return out;
}

/** Corrélation de rang de Spearman (0 si une série est constante). */
export function spearman(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): number {
  if (xs.length < 2 || xs.length !== ys.length) return 0;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const meanX = rx.reduce((sum, value) => sum + value, 0) / rx.length;
  const meanY = ry.reduce((sum, value) => sum + value, 0) / ry.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let index = 0; index < rx.length; index += 1) {
    const a = (rx[index] ?? 0) - meanX;
    const b = (ry[index] ?? 0) - meanY;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}

/** Force de la montée qui a ouvert la scène d'impact. */
export function dropStrength(view: TrackView, window: DropWindow): number {
  const builds = view.buildsEndingIn(window.start - 0.05, window.start + 0.05);
  return builds.reduce((max, build) => Math.max(max, build.strength), 0);
}

export interface ImpactWidth {
  track: string;
  index: number;
  start: number;
  strength: number;
  peak: number;
  half: number;
  /** Durée cumulée au-dessus de la moitié du pic, en secondes. */
  width: number;
}

/** Largeur d'impact : part de temps où la saturation dépasse la moitié du pic. */
export function impactWidth(
  times: ReadonlyArray<number>,
  ratios: ReadonlyArray<number>,
  fps: number,
): { peak: number; half: number; width: number } {
  let peak = 0;
  for (const ratio of ratios) peak = Math.max(peak, ratio);
  const half = peak * 0.5;
  let above = 0;
  for (const ratio of ratios) if (ratio >= half && half > 0) above += 1;
  return { peak, half, width: above / fps };
}

interface FlashTrack {
  track: string;
  total: number;
  maxPerSecond: number;
  worstAt: number | null;
  samples: number;
  /** Part de blanc maximale observée (flash plein écran). */
  maxWhiteRatio: number;
  /** Flashs de part de blanc : transitions rapides > `WHITE_FLASH_DELTA`. */
  whiteTotal: number;
  whiteMaxPerSecond: number;
  whiteWorstAt: number | null;
}

async function measureFlash(
  renderer: HeadlessRenderer,
  track: { name: string; analysis: unknown },
  reduced: boolean,
): Promise<FlashTrack> {
  const analysis = track.analysis as Parameters<typeof buildShowPlan>[0];
  const plan = buildShowPlan(analysis, reduced);
  const duration = Math.max(0, plan.duration);
  const times = sampleTimes(0, duration, METRIC_FPS);
  await renderer.setup({
    analysis,
    reduced,
    width: 320,
    height: 180,
    dpr: 1,
    quality: 1,
    settings: { ...DEFAULT_SETTINGS, reduced },
    reducedMotion: reduced,
  });
  const metrics: FrameMetric[] = await renderer.frameMetrics(times, METRIC_FPS);
  const flashes = detectFlashTimes(metrics.map((metric) => metric.meanLuminance), METRIC_FPS);
  const worst = maxFlashesPerSecond(flashes);
  const whiteRatios = metrics.map((metric) => metric.whiteRatio);
  const whiteFlashes = detectFlashTimes(whiteRatios, METRIC_FPS, WHITE_FLASH_DELTA);
  const whiteWorst = maxFlashesPerSecond(whiteFlashes);
  return {
    track: track.name,
    total: flashes.length,
    maxPerSecond: worst.max,
    worstAt: worst.at,
    samples: metrics.length,
    maxWhiteRatio: whiteRatios.reduce((max, ratio) => Math.max(max, ratio), 0),
    whiteTotal: whiteFlashes.length,
    whiteMaxPerSecond: whiteWorst.max,
    whiteWorstAt: whiteWorst.at,
  };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const corpusIndex = args.indexOf("--corpus");
  const corpus = corpusIndex >= 0 ? (args[corpusIndex + 1] ?? DEFAULT_CORPUS_DIR) : DEFAULT_CORPUS_DIR;
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const real: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--real" && args[index + 1] !== undefined) real.push(args[index + 1]!);
  }

  const tracks = loadCorpusAnalyses(corpus);
  if (real.length > 0) tracks.push(...loadRealAnalyses(real));

  const wantWidth = args.includes("--width");
  const wantFlashes = args.includes("--flashes");

  const started = performance.now();
  const renderer = await createHeadlessRenderer();
  const measured: Array<{ track: string; source: string; drops: DropSaturation[] }> = [];
  const widths: ImpactWidth[] = [];
  const correlations: Array<{ track: string; strength: number; peak: number }> = [];
  const flashesNormal: FlashTrack[] = [];
  const flashesReduced: FlashTrack[] = [];
  try {
    for (const track of tracks) {
      const drops = await sampleDrops(renderer, track);
      measured.push({ track: track.name, source: track.source, drops });
      if (wantWidth) {
        const view = new TrackView(track.analysis);
        for (const drop of drops) {
          const times = sampleTimes(drop.window.start, drop.window.end, METRIC_FPS);
          const metrics = await renderer.frameMetrics(times, METRIC_FPS);
          const ratios = metrics.map((metric) => metric.whiteRatio);
          const shape = impactWidth(times, ratios, METRIC_FPS);
          const strength = dropStrength(view, drop.window);
          widths.push({
            track: track.name,
            index: drop.window.index,
            start: drop.window.start,
            strength,
            peak: shape.peak,
            half: shape.half,
            width: shape.width,
          });
          correlations.push({ track: track.name, strength, peak: shape.peak });
        }
      }
    }
    if (wantFlashes) {
      for (const track of tracks) {
        flashesNormal.push(await measureFlash(renderer, track, false));
        flashesReduced.push(await measureFlash(renderer, track, true));
      }
    }
  } finally {
    await renderer.close();
  }
  const elapsed = (performance.now() - started) / 1000;
  const allDrops = measured.flatMap((entry) => entry.drops);
  const aggregate = aggregateSaturation(allDrops);

  console.log("=== Saturation des drops (part de pixels proches du blanc) ===");
  for (const entry of measured) {
    if (entry.drops.length === 0) {
      console.log(`${entry.track.padEnd(12)} aucun drop`);
      continue;
    }
    for (const drop of entry.drops) {
      console.log(
        `${entry.track.padEnd(12)} drop #${String(drop.window.index).padStart(2)} ` +
          `${drop.window.start.toFixed(2)}→${drop.window.end.toFixed(2)} ` +
          `${drop.window.family.padEnd(14)} n=${String(drop.ratios.length).padStart(3)} ` +
          formatStats(drop.stats),
      );
    }
  }
  console.log(
    `\nTotal : ${aggregate.drops} drops · ${aggregate.samples} échantillons · ` +
      formatStats(aggregate.stats),
  );

  let widthSummary: ReturnType<typeof stats> | null = null;
  let correlation: number | null = null;
  if (wantWidth && widths.length > 0) {
    widthSummary = stats(widths.map((entry) => entry.width));
    correlation = spearman(
      correlations.map((entry) => entry.strength),
      correlations.map((entry) => entry.peak),
    );
    console.log(
      `\nLargeur d'impact (${METRIC_FPS} Hz, > 50 % du pic) : ` +
        `min ${widthSummary.min.toFixed(3)} s · méd ${widthSummary.median.toFixed(3)} s · ` +
        `max ${widthSummary.max.toFixed(3)} s`,
    );
    console.log(`Corrélation strength ↔ pic de saturation : Spearman ${correlation.toFixed(3)}`);
  }
  if (wantFlashes) {
    const normalMax = Math.max(0, ...flashesNormal.map((entry) => entry.maxPerSecond));
    const reducedMax = Math.max(0, ...flashesReduced.map((entry) => entry.maxPerSecond));
    console.log(`\nFlashs/s (${METRIC_FPS} Hz, transition de luminance > ${FLASH_DELTA}) :`);
    for (const entry of flashesNormal) {
      const reduced = flashesReduced.find((candidate) => candidate.track === entry.track);
      console.log(
        `${entry.track.padEnd(12)} normal max ${entry.maxPerSecond.toFixed(0)}/s ` +
          `(${entry.total} flashs, pire à ${entry.worstAt === null ? "—" : `${entry.worstAt.toFixed(2)} s`}) · ` +
          `réduit max ${reduced?.maxPerSecond.toFixed(0) ?? 0}/s · ` +
          `blanc normal ${entry.whiteMaxPerSecond}/s (pic ${entry.maxWhiteRatio.toFixed(3)}) · ` +
          `blanc réduit ${reduced?.whiteMaxPerSecond ?? 0}/s (pic ${(reduced?.maxWhiteRatio ?? 0).toFixed(3)})`,
      );
    }
    console.log(`Pire fenêtre : normal ${normalMax}/s · réduit ${reducedMax}/s`);
  }
  console.log(`(${tracks.length} pistes, ${elapsed.toFixed(2)} s)`);

  if (out !== undefined) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      stableStringify({
        method: {
          fps: 10,
          whiteLuminance: 0.92,
          whiteSaturation: 0.15,
          width: 320,
          height: 180,
          metricFps: METRIC_FPS,
          flashDelta: FLASH_DELTA,
        },
        tracks: measured,
        aggregate,
        ...(wantWidth
          ? {
              impactWidth: {
                fps: METRIC_FPS,
                perDrop: widths,
                summary: widthSummary,
                spearmanStrengthPeak: correlation,
              },
            }
          : {}),
        ...(wantFlashes
          ? {
              flashes: {
                fps: METRIC_FPS,
                luminanceDelta: FLASH_DELTA,
                normal: flashesNormal,
                reduced: flashesReduced,
              },
            }
          : {}),
      }),
      "utf8",
    );
    console.log(`JSON machine : ${out}`);
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`saturation-report : ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
