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
  renderLoop,
  compareContinuousSeek,
};
