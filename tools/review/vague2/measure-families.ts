#!/usr/bin/env bun
/**
 * Mesure croisée de la sécurité photosensible, par famille de drop (vague 2).
 *
 *   uv run python tools/real_corpus.py         # une fois : analyses réelles
 *   bun tools/review/vague2/measure-families.ts [--cache <analyse.json>]
 *
 * Par défaut : corpus réel du manifeste (`tests/support/real_corpus.json`),
 * 10 morceaux. `--cache` lit un cache `loadRealAnalyses` (liste de
 * `{name, analysis}`), utile pour rejouer le corpus de `tools/vague1-report.json`.
 *
 * Sortie JSON sur stdout ; diagnostics sur stderr. Aucune métrique produit
 * n'est modifiée : ce script est un outil de revue, il ne change pas le rendu.
 */

import { readFileSync } from "node:fs";

import { buildShowPlan } from "../../../src/core/show";
import { DEFAULT_SETTINGS } from "../../../src/types";
import { TrackView } from "../../../src/core/view";
import { dropWindows, sampleTimes } from "../../../tests/support/drop_saturation";
import { createHeadlessRenderer } from "../../../tests/support/headless_render";
import { loadRealCorpus } from "../../../tests/support/plan_corpus";
import type { Analysis } from "../../../src/types";

const METRIC_FPS = 30;
const FLASH_DELTA = 0.1;
const WHITE_FLASH_DELTA = 0.05;

interface Metric {
  whiteRatio: number;
  meanLuminance: number;
}

interface TrackEntry {
  name: string;
  analysis: unknown;
}

function detectFlashTimes(luminances: ReadonlyArray<number>, delta = FLASH_DELTA): number[] {
  const lookahead = Math.max(1, Math.round(0.5 * METRIC_FPS));
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
    times.push(peak / METRIC_FPS);
    index = Math.min(luminances.length - 1, peak + Math.max(1, Math.round(0.15 * METRIC_FPS)));
  }
  return times;
}

function maxPerSecond(times: ReadonlyArray<number>): { max: number; at: number | null } {
  let max = 0;
  let at: number | null = null;
  let end = 0;
  for (let start = 0; start < times.length; start += 1) {
    while (end < times.length && (times[end] ?? 0) < (times[start] ?? 0) + 1 - 1e-9) end += 1;
    const count = end - start;
    if (count > max) {
      max = count;
      at = times[start] ?? null;
    }
  }
  return { max, at };
}

function spearman(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): number {
  if (xs.length < 2 || xs.length !== ys.length) return 0;
  const rank = (values: ReadonlyArray<number>): number[] => {
    const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
    const out = Array.from<number>({ length: values.length }).fill(0);
    let index = 0;
    while (index < order.length) {
      let end = index + 1;
      while (end < order.length && order[end]?.value === order[index]?.value) end += 1;
      const value = (index + end - 1) / 2 + 1;
      for (let cursor = index; cursor < end; cursor += 1) out[order[cursor]!.index] = value;
      index = end;
    }
    return out;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = rx.reduce((sum, value) => sum + value, 0) / rx.length;
  const my = ry.reduce((sum, value) => sum + value, 0) / ry.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let index = 0; index < rx.length; index += 1) {
    const a = (rx[index] ?? 0) - mx;
    const b = (ry[index] ?? 0) - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}

function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const args = process.argv.slice(2);
const cacheIndex = args.indexOf("--cache");
const cache = cacheIndex >= 0 ? args[cacheIndex + 1] : undefined;

const tracks: TrackEntry[] =
  cache === undefined
    ? (loadRealCorpus() as TrackEntry[])
    : (JSON.parse(readFileSync(cache, "utf8")) as TrackEntry[]);

const renderer = await createHeadlessRenderer();
const perDrop: Array<{
  track: string;
  index: number;
  family: string;
  start: number;
  end: number;
  strength: number;
  peak: number;
  width: number;
  flashesIn15: number;
}> = [];
const perTrack: Array<{
  track: string;
  tempo: number;
  drops: number;
  normalMax: number;
  reducedMax: number;
  maxWhiteReduced: number;
  whiteFlashReduced: number;
}> = [];

try {
  for (const track of tracks) {
    const plan = buildShowPlan(track.analysis as Analysis, false);
    const windows = dropWindows(track.name, plan);
    const view = new TrackView(track.analysis as Analysis);
    const times = sampleTimes(0, Math.max(0, plan.duration), METRIC_FPS);

    await renderer.setup({
      analysis: track.analysis as Analysis,
      reduced: false,
      width: 320,
      height: 180,
      dpr: 1,
      quality: 1,
      settings: { ...DEFAULT_SETTINGS },
      reducedMotion: false,
    });
    const normal = (await renderer.frameMetrics(times, METRIC_FPS)) as Metric[];
    const normalFlashes = detectFlashTimes(normal.map((metric) => metric.meanLuminance));

    for (const window of windows) {
      const dropTimes = sampleTimes(window.start, window.end, METRIC_FPS);
      const metrics = (await renderer.frameMetrics(dropTimes, METRIC_FPS)) as Metric[];
      const ratios = metrics.map((metric) => metric.whiteRatio);
      const peak = ratios.reduce((max, ratio) => Math.max(max, ratio), 0);
      const half = peak * 0.5;
      const width = ratios.filter((ratio) => half > 0 && ratio >= half).length / METRIC_FPS;
      perDrop.push({
        track: track.name,
        index: window.index,
        family: window.family,
        start: window.start,
        end: window.end,
        strength: view
          .buildsEndingIn(window.start - 0.05, window.start + 0.05)
          .reduce((max, build) => Math.max(max, build.strength), 0),
        peak,
        width,
        flashesIn15: normalFlashes.filter((time) => time >= window.start && time <= window.start + 1.5).length,
      });
    }

    await renderer.setup({
      analysis: track.analysis as Analysis,
      reduced: true,
      width: 320,
      height: 180,
      dpr: 1,
      quality: 1,
      settings: { ...DEFAULT_SETTINGS, reduced: true },
      reducedMotion: true,
    });
    const reduced = (await renderer.frameMetrics(times, METRIC_FPS)) as Metric[];
    const reducedFlashes = detectFlashTimes(reduced.map((metric) => metric.meanLuminance));
    const whiteFlashes = detectFlashTimes(
      reduced.map((metric) => metric.whiteRatio),
      WHITE_FLASH_DELTA,
    );
    perTrack.push({
      track: track.name,
      tempo: (track.analysis as Analysis).tempo,
      drops: windows.length,
      normalMax: maxPerSecond(normalFlashes).max,
      reducedMax: maxPerSecond(reducedFlashes).max,
      maxWhiteReduced: reduced.reduce((max, metric) => Math.max(max, metric.whiteRatio), 0),
      whiteFlashReduced: whiteFlashes.length,
    });
    console.error(
      `${track.name} : ${windows.length} drops, normal ${perTrack.at(-1)!.normalMax}/s, ` +
        `réduit ${perTrack.at(-1)!.reducedMax}/s, blanc max ${perTrack.at(-1)!.maxWhiteReduced.toFixed(3)}`,
    );
  }
} finally {
  await renderer.close();
}

const families = [...new Set(perDrop.map((drop) => drop.family))].sort();
const byFamily = families.map((family) => {
  const drops = perDrop.filter((drop) => drop.family === family);
  const widths = drops.map((drop) => drop.width);
  return {
    family,
    drops: drops.length,
    maxPeak: Math.max(0, ...drops.map((drop) => drop.peak)),
    minWidth: Math.min(...widths),
    medianWidth: median(widths),
    maxWidth: Math.max(...widths),
    maxFlashes15: Math.max(0, ...drops.map((drop) => drop.flashesIn15)),
  };
});

const perTrackMax = new Map<string, number>();
for (const drop of perDrop) perTrackMax.set(drop.track, Math.max(perTrackMax.get(drop.track) ?? 0, drop.peak));

console.log(
  JSON.stringify(
    {
      corpus: cache === undefined ? "manifest" : cache,
      fps: METRIC_FPS,
      tracks: perTrack,
      families: byFamily,
      spearman: spearman(
        perDrop.map((drop) => drop.strength),
        perDrop.map((drop) => drop.peak),
      ),
      global: {
        drops: perDrop.length,
        normalMax: Math.max(0, ...perTrack.map((track) => track.normalMax)),
        reducedMax: Math.max(0, ...perTrack.map((track) => track.reducedMax)),
        maxWhiteReduced: Math.max(0, ...perTrack.map((track) => track.maxWhiteReduced)),
        widthMin: Math.min(...perDrop.map((drop) => drop.width)),
        widthMedian: median(perDrop.map((drop) => drop.width)),
        widthMax: Math.max(...perDrop.map((drop) => drop.width)),
        dropsOver025: perDrop.filter((drop) => drop.peak >= 0.25).length,
        distinctPeaks3: new Set(perDrop.map((drop) => drop.peak.toFixed(3))).size,
        maxPeakPerTrack: Object.fromEntries([...perTrackMax.entries()].sort((a, b) => b[1] - a[1])),
      },
    },
    null,
    2,
  ),
);
