/**
 * Entrée navigateur du rendu headless, bundlée par `headless_render.ts`.
 *
 * Ce fichier n'est pas un test : il est compilé pour Chromium headless et
 * expose une petite API synchrone sur `globalThis.__nightlight`. Il permet de
 * rendre une image réelle (vrai canvas) et de comparer des pixels, sans jamais
 * toucher à l'application ni au rendu de production.
 */

import { renderFrame } from "../../src/core/render";
import { buildShowPlan, type ShowPlan } from "../../src/core/show";
import { TrackView } from "../../src/core/view";
import type { Analysis, RenderSettings } from "../../src/types";
import { whitePixels } from "./saturation";

interface SetupPayload {
  analysis: Analysis;
  /** Plan réduit (`prefers-reduced-motion`). */
  reduced: boolean;
  width: number;
  height: number;
  dpr: number;
  quality: number;
  settings: RenderSettings;
  reducedMotion: boolean;
}

interface Session {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  view: TrackView;
  plan: ShowPlan;
  setup: SetupPayload;
}

interface DrawTarget {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

let session: Session | null = null;

function createTarget(setup: SetupPayload): DrawTarget {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(setup.width * setup.dpr));
  canvas.height = Math.max(1, Math.round(setup.height * setup.dpr));
  const ctx = canvas.getContext("2d", { alpha: false });
  if (ctx === null) throw new Error("canvas 2d indisponible");
  return { canvas, ctx };
}

function draw(
  target: DrawTarget,
  setup: SetupPayload,
  view: TrackView,
  plan: ShowPlan,
  time: number,
  frame: number,
): void {
  // Neutralise le cache de rastérisation Skia interne au canvas. Il ne masque
  // aucun état applicatif : sans reset, le résidu mesuré est de 146 px / 57 600
  // (delta max 4 niveaux), dû au seul moteur, et la production ne fait
  // volontairement pas ce reset (le seek applicatif peut donc garder ce résidu).
  target.ctx.reset();
  renderFrame({
    ctx: target.ctx,
    width: setup.width,
    height: setup.height,
    dpr: setup.dpr,
    time,
    view,
    plan,
    settings: setup.settings,
    reducedMotion: setup.reducedMotion,
    quality: setup.quality,
    frame,
  });
}

function pixels(target: DrawTarget): Uint8ClampedArray {
  return target.ctx.getImageData(0, 0, target.canvas.width, target.canvas.height).data;
}

/** FNV-1a 32 bits sur les octets RGBA : empreinte exacte de l'image. */
function hashPixels(data: Uint8ClampedArray): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data[index] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function setup(payload: SetupPayload): { scenes: number; width: number; height: number } {
  const target = createTarget(payload);
  const view = new TrackView(payload.analysis);
  const plan = buildShowPlan(payload.analysis, payload.reduced);
  session = { canvas: target.canvas, ctx: target.ctx, view, plan, setup: payload };
  return { scenes: plan.scenes.length, width: target.canvas.width, height: target.canvas.height };
}

function renderAt(time: number, frame: number): void {
  if (session === null) throw new Error("setup() d'abord");
  draw(session, session.setup, session.view, session.plan, time, frame);
}

/** Variante sérialisable de `renderAt` pour l'API exposée. */
function renderAtPayload(payload: { time: number; frame: number }): void {
  renderAt(payload.time, payload.frame);
}

/** Efface le canvas courant (diagnostic de dépendance à l'historique). */
function clear(): void {
  if (session === null) throw new Error("setup() d'abord");
  session.ctx.setTransform(1, 0, 0, 1, 0, 0);
  session.ctx.globalCompositeOperation = "source-over";
  session.ctx.globalAlpha = 1;
  session.ctx.clearRect(0, 0, session.canvas.width, session.canvas.height);
}

function whiteRatioAt(time: number, frame: number): number {
  renderAt(time, frame);
  if (session === null) throw new Error("setup() d'abord");
  return whitePixels(pixels(session)).ratio;
}

/** Part de blanc pour une série d'instants, en un seul aller-retour. */
function whiteRatios(payload: { times: number[]; fps: number }): number[] {
  return payload.times.map((time) => whiteRatioAt(time, Math.round(time * payload.fps)));
}

function imageStats(payload: { time: number; frame: number }): {
  hash: string;
  whiteRatio: number;
  total: number;
  white: number;
} {
  renderAt(payload.time, payload.frame);
  if (session === null) throw new Error("setup() d'abord");
  const data = pixels(session);
  const stats = whitePixels(data);
  return {
    hash: hashPixels(data),
    whiteRatio: stats.ratio,
    total: stats.total,
    white: stats.white,
  };
}

/**
 * Capture 1080p d'une image : PNG (data URL) et mesures d'éclairage.
 *
 * - luminance : moyenne Rec. 709, 0..1 ;
 * - part de blanc : définition de `saturation.ts` (luminance > 0,92 et
 *   saturation < 0,15) ;
 * - centre/bords : luminance moyenne du cadre central 50 % divisée par celle
 *   des bords (0 quand les bords sont noirs) ;
 * - teintes dominantes : histogramme 12 × 30° pondéré par la saturation, une
 *   teinte compte si elle porte au moins 8 % de la couleur de l'image.
 */
function capture(payload: { time: number; frame: number }): {
  png: string;
  width: number;
  height: number;
  luminanceMean: number;
  whiteRatio: number;
  centerEdgeRatio: number;
  dominantHues: number;
  hueBuckets: Array<{ hue: number; share: number }>;
} {
  renderAt(payload.time, payload.frame);
  if (session === null) throw new Error("setup() d'abord");
  const canvas = session.canvas;
  const width = canvas.width;
  const height = canvas.height;
  const data = pixels(session);
  const white = whitePixels(data);
  let luminanceSum = 0;
  let centerSum = 0;
  let centerCount = 0;
  let borderSum = 0;
  let borderCount = 0;
  const buckets = Array.from({ length: 12 }, () => 0);
  let chromatic = 0;
  const x0 = width / 4;
  const x1 = (width * 3) / 4;
  const y0 = height / 4;
  const y1 = (height * 3) / 4;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const index = pixel * 4;
    const r = (data[index] ?? 0) / 255;
    const g = (data[index + 1] ?? 0) / 255;
    const b = (data[index + 2] ?? 0) / 255;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luminanceSum += luminance;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (x >= x0 && x < x1 && y >= y0 && y < y1) {
      centerSum += luminance;
      centerCount += 1;
    } else {
      borderSum += luminance;
      borderCount += 1;
    }
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    if (saturation < 0.2 || luminance < 0.05) continue;
    let hue: number;
    if (max === min) hue = 0;
    else if (max === r) hue = ((g - b) / (max - min)) % 6;
    else if (max === g) hue = (b - r) / (max - min) + 2;
    else hue = (r - g) / (max - min) + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
    const bucket = Math.min(11, Math.floor(hue / 30));
    const weight = saturation * luminance;
    buckets[bucket] = (buckets[bucket] ?? 0) + weight;
    chromatic += weight;
  }
  const total = width * height;
  const hueBuckets = buckets.map((weight, index) => ({
    hue: index * 30,
    share: chromatic === 0 ? 0 : weight / chromatic,
  }));
  const centerMean = centerCount === 0 ? 0 : centerSum / centerCount;
  const borderMean = borderCount === 0 ? 0 : borderSum / borderCount;
  return {
    png: canvas.toDataURL("image/png"),
    width,
    height,
    luminanceMean: total === 0 ? 0 : luminanceSum / total,
    whiteRatio: white.ratio,
    centerEdgeRatio: borderMean === 0 ? 0 : centerMean / borderMean,
    dominantHues: hueBuckets.filter((bucket) => bucket.share >= 0.08).length,
    hueBuckets,
  };
}

/** Boucle de rendu in-page, pour mesurer un coût par image sans aller-retour. */
function renderLoop(payload: {
  count: number;
  fps: number;
  start: number;
}): { scenes: number; elapsedMs: number; perFrameMs: number } {
  if (session === null) throw new Error("setup() d'abord");
  const started = performance.now();
  for (let index = 0; index < payload.count; index += 1) {
    const time = payload.start + index / payload.fps;
    renderAt(time, Math.round(time * payload.fps));
  }
  const elapsedMs = performance.now() - started;
  return {
    scenes: session.plan.scenes.length,
    elapsedMs,
    perFrameMs: payload.count === 0 ? 0 : elapsedMs / payload.count,
  };
}

interface ComparePayload extends SetupPayload {
  /** Instant final, en secondes. */
  time: number;
  /** Cadence du rendu continu, en images/s. */
  fps: number;
  /**
   * Rend une fois `time` sur chaque canvas avant la mesure. Sert à isoler
   * l'artefact de premier rendu du cache de dégradés de Skia : après chauffe,
   * la comparaison doit être exacte.
   */
  warmup?: boolean;
}

/**
 * Rend `0 → time` en continu sur un canvas, puis `time` seul après un « seek »
 * sur un canvas neuf, et compare les pixels.
 */
function compareContinuousSeek(payload: ComparePayload): {
  time: number;
  diffPixels: number;
  maxDelta: number;
  totalPixels: number;
  hashContinuous: string;
  hashSeek: string;
  whiteRatioContinuous: number;
  whiteRatioSeek: number;
  scenes: number;
  diffBBox: { minX: number; minY: number; maxX: number; maxY: number } | null;
  diffSamples: Array<{ x: number; y: number; before: number[]; after: number[] }>;
} {
  const view = new TrackView(payload.analysis);
  const plan = buildShowPlan(payload.analysis, payload.reduced);
  const frame = Math.round(payload.time * payload.fps);

  const continuous = createTarget(payload);
  const seek = createTarget(payload);
  if (payload.warmup === true) {
    // Chauffe identique des deux canvas : élimine le premier usage du cache de
    // dégradés de Skia, qui décale 1 à 4 niveaux sur du fond sombre.
    draw(continuous, payload, view, plan, payload.time, frame);
    draw(seek, payload, view, plan, payload.time, frame);
  }

  const lastWhole = Math.floor(payload.time * payload.fps);
  for (let index = 0; index <= lastWhole; index += 1) {
    draw(continuous, payload, view, plan, index / payload.fps, index);
  }
  // L'image demandée exactement à `time`, après l'historique continu.
  draw(continuous, payload, view, plan, payload.time, frame);

  draw(seek, payload, view, plan, payload.time, frame);

  const before = pixels(continuous);
  const after = pixels(seek);
  let diffPixels = 0;
  let maxDelta = 0;
  const totalPixels = Math.min(before.length, after.length) / 4;
  const width = continuous.canvas.width;
  const bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const diffSamples: Array<{ x: number; y: number; before: number[]; after: number[] }> = [];
  for (let index = 0; index < Math.min(before.length, after.length); index += 4) {
    let delta = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      delta = Math.max(delta, Math.abs((before[index + channel] ?? 0) - (after[index + channel] ?? 0)));
    }
    if (delta > 0) {
      diffPixels += 1;
      const pixel = index / 4;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      bbox.minX = Math.min(bbox.minX, x);
      bbox.minY = Math.min(bbox.minY, y);
      bbox.maxX = Math.max(bbox.maxX, x);
      bbox.maxY = Math.max(bbox.maxY, y);
      if (diffSamples.length < 5) {
        diffSamples.push({
          x,
          y,
          before: [before[index] ?? 0, before[index + 1] ?? 0, before[index + 2] ?? 0, before[index + 3] ?? 0],
          after: [after[index] ?? 0, after[index + 1] ?? 0, after[index + 2] ?? 0, after[index + 3] ?? 0],
        });
      }
    }
    if (delta > maxDelta) maxDelta = delta;
  }

  return {
    time: payload.time,
    diffPixels,
    maxDelta,
    totalPixels,
    hashContinuous: hashPixels(before),
    hashSeek: hashPixels(after),
    whiteRatioContinuous: whitePixels(before).ratio,
    whiteRatioSeek: whitePixels(after).ratio,
    scenes: plan.scenes.length,
    diffBBox: diffPixels === 0 ? null : bbox,
    diffSamples,
  };
}

export interface HeadlessApi {
  setup: typeof setup;
  renderAt: typeof renderAtPayload;
  clear: typeof clear;
  whiteRatioAt: typeof whiteRatioAt;
  whiteRatios: typeof whiteRatios;
  imageStats: typeof imageStats;
  capture: typeof capture;
  renderLoop: typeof renderLoop;
  compareContinuousSeek: typeof compareContinuousSeek;
}

(globalThis as unknown as { __nightlight: HeadlessApi }).__nightlight = {
  setup,
  renderAt: renderAtPayload,
  clear,
  whiteRatioAt,
  whiteRatios,
  imageStats,
  capture,
  renderLoop,
  compareContinuousSeek,
};
